import { describe, it, expect } from "vitest";
import { decideRefundEligibility, type RefundFacts } from "./refunds.server";

// Local-time dates, so the calendar-day rules hold in any timezone.
function at(year: number, month: number, day: number, hour = 12) {
  return new Date(year, month - 1, day, hour);
}

function facts(overrides: Partial<RefundFacts> = {}): RefundFacts {
  return {
    purchase: {
      createdAt: at(2026, 3, 1).toISOString(),
      amountPaid: 7900,
      country: null,
    },
    coursePrice: 7900,
    hasRequestedRefund: false,
    isClaimedSeat: false,
    completedLessonCount: 0,
    totalLessonCount: 10,
    secondsWatched: 0,
    ...overrides,
  };
}

describe("decideRefundEligibility", () => {
  it("offers a Refund of the list price inside the Refund Window", () => {
    expect(decideRefundEligibility(facts(), at(2026, 3, 5))).toEqual({
      eligible: true,
      amount: 7900,
      lastDayInWindow: "2026-03-15",
    });
  });

  describe("Refund Window", () => {
    it("is still open at the end of its last day, even for a late-evening Purchase", () => {
      const late = facts({
        purchase: {
          createdAt: at(2026, 3, 1, 23).toISOString(),
          amountPaid: 7900,
          country: null,
        },
      });
      expect(decideRefundEligibility(late, at(2026, 3, 15, 23)).eligible).toBe(
        true
      );
    });

    it("is closed the day after its last day", () => {
      expect(decideRefundEligibility(facts(), at(2026, 3, 16, 0))).toEqual({
        eligible: false,
        reason: "window_closed",
      });
    });
  });

  it("gives back the price actually paid for a purchasing-power Purchase", () => {
    const ppp = facts({
      purchase: {
        createdAt: at(2026, 3, 1).toISOString(),
        amountPaid: 3950,
        country: "IN",
      },
    });
    expect(decideRefundEligibility(ppp, at(2026, 3, 5))).toMatchObject({
      eligible: true,
      amount: 3950,
    });
  });

  it("refuses a Refund without a Purchase", () => {
    expect(decideRefundEligibility(facts({ purchase: null }), at(2026, 3, 5))).toEqual({
      eligible: false,
      reason: "no_purchase",
    });
  });

  it("refuses a second Refund while one is already Requested", () => {
    expect(
      decideRefundEligibility(facts({ hasRequestedRefund: true }), at(2026, 3, 5))
    ).toEqual({ eligible: false, reason: "already_requested" });
  });

  it("refuses a Refund on a Claimed Seat", () => {
    expect(
      decideRefundEligibility(facts({ isClaimedSeat: true }), at(2026, 3, 5))
    ).toEqual({ eligible: false, reason: "seat_claimed" });
  });

  describe("course used", () => {
    it("allows a Refund with just under half the lessons completed", () => {
      const used = facts({ completedLessonCount: 4, totalLessonCount: 10 });
      expect(decideRefundEligibility(used, at(2026, 3, 5)).eligible).toBe(true);
    });

    it("refuses a Refund once half the lessons are completed", () => {
      const used = facts({ completedLessonCount: 5, totalLessonCount: 10 });
      expect(decideRefundEligibility(used, at(2026, 3, 5))).toEqual({
        eligible: false,
        reason: "too_much_completed",
      });
    });

    it("does not count completion for a course with no lessons", () => {
      const empty = facts({ completedLessonCount: 0, totalLessonCount: 0 });
      expect(decideRefundEligibility(empty, at(2026, 3, 5)).eligible).toBe(
        true
      );
    });

    it("refuses a Refund once two hours have been watched", () => {
      const watched = facts({ secondsWatched: 2 * 60 * 60 });
      expect(decideRefundEligibility(watched, at(2026, 3, 5))).toEqual({
        eligible: false,
        reason: "too_much_watched",
      });
    });

    it("allows a Refund with just under two hours watched", () => {
      const watched = facts({ secondsWatched: 2 * 60 * 60 - 1 });
      expect(decideRefundEligibility(watched, at(2026, 3, 5)).eligible).toBe(
        true
      );
    });
  });
});
