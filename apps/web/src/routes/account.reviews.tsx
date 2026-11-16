import { createFileRoute } from "@tanstack/react-router";
import { OwnReviews } from "~/features/reputation/reviews";
export const Route = createFileRoute("/account/reviews")({ component: OwnReviews });
