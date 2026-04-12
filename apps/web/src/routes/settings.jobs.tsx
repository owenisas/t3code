import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/settings/jobs")({
  beforeLoad: () => {
    throw redirect({ to: "/jobs", replace: true });
  },
});
