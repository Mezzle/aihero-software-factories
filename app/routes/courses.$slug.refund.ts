import { data, redirect } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/courses.$slug.refund";
import { getCurrentUserId } from "~/lib/session";
import { db } from "~/db";
import { courses, refunds, users, RefundStatus } from "~/db/schema";
import { eq } from "drizzle-orm";
import { parseFormData, parseParams } from "~/lib/validation";
import { formatPrice } from "~/lib/utils";
import {
  getRefundEligibility,
  REFUND_INELIGIBLE_RESPONSES,
} from "~/lib/refunds.server";

const refundParamsSchema = z.object({
  slug: z.string().min(1),
});

const refundActionSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(10, "Tell us a little more about why you want a refund.")
    .max(1000, "Please keep your reason under 1000 characters."),
});

function getCourseBySlug(slug: string) {
  return db.select().from(courses).where(eq(courses.slug, slug)).get();
}

/**
 * The confirmation the Student gets in their inbox. There is no mail
 * transport wired up yet, so the built message goes to the server log.
 */
function buildRefundEmail(input: {
  studentName: string;
  studentEmail: string;
  courseTitle: string;
  amount: number;
}) {
  return {
    to: input.studentEmail,
    subject: `Refund requested — ${input.courseTitle}`,
    body: [
      `Hi ${input.studentName},`,
      "",
      `We have your refund request for "${input.courseTitle}".`,
      `The refund is for ${formatPrice(input.amount)}, the amount you paid.`,
      "",
      "Our team reviews every refund by hand. You do not need to do anything else — we will email you again when it is done.",
      "",
      "— The Cadence team",
    ].join("\n"),
  };
}

export async function action({ params, request }: Route.ActionArgs) {
  const currentUserId = await getCurrentUserId(request);

  if (!currentUserId) {
    throw data("You must be logged in to request a refund.", { status: 401 });
  }

  const { slug } = parseParams(params, refundParamsSchema);
  const course = getCourseBySlug(slug);

  if (!course) {
    throw data("Course not found", { status: 404 });
  }

  const student = db
    .select()
    .from(users)
    .where(eq(users.id, currentUserId))
    .get();

  if (!student) {
    throw data("User not found", { status: 404 });
  }

  const { purchaseId, eligibility } = getRefundEligibility(
    currentUserId,
    course
  );

  if (!eligibility.eligible) {
    const { message, status } = REFUND_INELIGIBLE_RESPONSES[eligibility.reason];
    throw data(message, { status });
  }

  const formData = await request.formData();
  const parsed = parseFormData(formData, refundActionSchema);

  if (!parsed.success) {
    return data({ errors: parsed.errors }, { status: 400 });
  }

  db.insert(refunds)
    .values({
      purchaseId: purchaseId!,
      status: RefundStatus.Requested,
      reason: parsed.data.reason,
    })
    .run();

  const email = buildRefundEmail({
    studentName: student.name,
    studentEmail: student.email,
    courseTitle: course.title,
    amount: eligibility.amount,
  });

  console.log(
    `[email] to=${email.to} subject=${email.subject}\n${email.body}`
  );

  return redirect("/settings");
}
