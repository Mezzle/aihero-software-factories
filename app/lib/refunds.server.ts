import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "~/db";
import {
  coupons,
  lessonProgress,
  lessons,
  modules,
  purchases,
  refunds,
  videoWatchEvents,
  LessonProgressStatus,
  RefundStatus,
} from "~/db/schema";
import { getDiscountForCountry } from "~/lib/ppp";

export const REFUND_WINDOW_DAYS = 14;
export const REFUND_COMPLETION_LIMIT = 0.5;
export const REFUND_WATCH_LIMIT_SECONDS = 2 * 60 * 60;

export interface RefundFacts {
  purchase: { createdAt: string; amountPaid: number; country: string | null } | null;
  coursePrice: number;
  hasRequestedRefund: boolean;
  isClaimedSeat: boolean;
  completedLessonCount: number;
  totalLessonCount: number;
  secondsWatched: number;
}

export type RefundIneligibleReason =
  | "no_purchase"
  | "already_requested"
  | "seat_claimed"
  | "window_closed"
  | "too_much_completed"
  | "too_much_watched";

export type RefundEligibility =
  | { eligible: true; amount: number; lastDayInWindow: string }
  | { eligible: false; reason: RefundIneligibleReason };

// The Refund Window is counted in whole calendar days, not hours — someone who
// buys at 23:00 still gets the whole of their fourteenth day.
function calendarDay(when: Date): string {
  const month = String(when.getMonth() + 1).padStart(2, "0");
  const day = String(when.getDate()).padStart(2, "0");
  return `${when.getFullYear()}-${month}-${day}`;
}

export function decideRefundEligibility(
  facts: RefundFacts,
  today: Date
): RefundEligibility {
  const { purchase } = facts;

  if (!purchase) return { eligible: false, reason: "no_purchase" };
  if (facts.hasRequestedRefund) {
    return { eligible: false, reason: "already_requested" };
  }
  // A Claimed Seat belongs to the team, so the Student cannot hand it back.
  if (facts.isClaimedSeat) return { eligible: false, reason: "seat_claimed" };

  const windowEnd = new Date(purchase.createdAt);
  windowEnd.setDate(windowEnd.getDate() + REFUND_WINDOW_DAYS);
  const lastDayInWindow = calendarDay(windowEnd);

  if (calendarDay(today) > lastDayInWindow) {
    return { eligible: false, reason: "window_closed" };
  }

  if (
    facts.totalLessonCount > 0 &&
    facts.completedLessonCount / facts.totalLessonCount >=
      REFUND_COMPLETION_LIMIT
  ) {
    return { eligible: false, reason: "too_much_completed" };
  }

  if (facts.secondsWatched >= REFUND_WATCH_LIMIT_SECONDS) {
    return { eligible: false, reason: "too_much_watched" };
  }

  // A Purchase at a purchasing-power price is given back at the price that was
  // paid, not at the list price of the course.
  const amount =
    getDiscountForCountry(purchase.country) > 0
      ? purchase.amountPaid
      : facts.coursePrice;

  return { eligible: true, amount, lastDayInWindow };
}

/** What the refund action tells a Student who is not eligible, and with which status. */
export const REFUND_INELIGIBLE_RESPONSES: Record<
  RefundIneligibleReason,
  { message: string; status: number }
> = {
  no_purchase: { message: "You have not bought this course.", status: 403 },
  already_requested: {
    message: "You already have a refund requested on this purchase.",
    status: 409,
  },
  seat_claimed: {
    message: "A claimed team seat cannot be refunded.",
    status: 403,
  },
  window_closed: {
    message: `The ${REFUND_WINDOW_DAYS}-day refund window has closed.`,
    status: 403,
  },
  too_much_completed: {
    message: "You have completed too much of this course to get a refund.",
    status: 403,
  },
  too_much_watched: {
    message: "You have watched too much of this course to get a refund.",
    status: 403,
  },
};

// ─── Gathering the facts ───

function getLatestPurchase(userId: number, courseId: number) {
  return db
    .select()
    .from(purchases)
    .where(and(eq(purchases.userId, userId), eq(purchases.courseId, courseId)))
    .orderBy(sql`${purchases.createdAt} desc`)
    .get();
}

function hasRequestedRefund(purchaseId: number) {
  const requested = db
    .select({ id: refunds.id })
    .from(refunds)
    .where(
      and(
        eq(refunds.purchaseId, purchaseId),
        eq(refunds.status, RefundStatus.Requested)
      )
    )
    .get();
  return !!requested;
}

function isClaimedSeat(purchaseId: number) {
  const claimed = db
    .select({ id: coupons.id })
    .from(coupons)
    .where(
      and(eq(coupons.purchaseId, purchaseId), isNotNull(coupons.redeemedAt))
    )
    .get();
  return !!claimed;
}

function getLessonIdsForCourse(courseId: number): number[] {
  return db
    .select({ id: lessons.id })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(modules.courseId, courseId))
    .all()
    .map((row) => row.id);
}

function getCompletedLessonCount(userId: number, lessonIds: number[]) {
  if (lessonIds.length === 0) return 0;

  const result = db
    .select({ count: sql<number>`count(*)` })
    .from(lessonProgress)
    .where(
      and(
        eq(lessonProgress.userId, userId),
        eq(lessonProgress.status, LessonProgressStatus.Completed),
        inArray(lessonProgress.lessonId, lessonIds)
      )
    )
    .get();

  return result?.count ?? 0;
}

// Watched time is the furthest point reached in each lesson, summed.
function getSecondsWatched(userId: number, lessonIds: number[]) {
  if (lessonIds.length === 0) return 0;

  return db
    .select({
      furthest: sql<number>`max(${videoWatchEvents.positionSeconds})`,
    })
    .from(videoWatchEvents)
    .where(
      and(
        eq(videoWatchEvents.userId, userId),
        inArray(videoWatchEvents.lessonId, lessonIds)
      )
    )
    .groupBy(videoWatchEvents.lessonId)
    .all()
    .reduce((total, row) => total + row.furthest, 0);
}

/**
 * Refund Eligibility for a Student's latest Purchase of a course, along with
 * that Purchase's id so a Refund can be recorded against it.
 */
export function getRefundEligibility(
  userId: number,
  course: { id: number; price: number },
  today: Date = new Date()
): { purchaseId: number | null; eligibility: RefundEligibility } {
  const purchase = getLatestPurchase(userId, course.id);
  const lessonIds = getLessonIdsForCourse(course.id);

  const eligibility = decideRefundEligibility(
    {
      purchase: purchase ?? null,
      coursePrice: course.price,
      hasRequestedRefund: purchase ? hasRequestedRefund(purchase.id) : false,
      isClaimedSeat: purchase ? isClaimedSeat(purchase.id) : false,
      completedLessonCount: getCompletedLessonCount(userId, lessonIds),
      totalLessonCount: lessonIds.length,
      secondsWatched: getSecondsWatched(userId, lessonIds),
    },
    today
  );

  return { purchaseId: purchase?.id ?? null, eligibility };
}
