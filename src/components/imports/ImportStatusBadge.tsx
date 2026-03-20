import * as React from "react";
import { Badge } from "@/components/ui/badge";

interface ImportStatusBadgeProps {
  status: string;
}

const statusConfig: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  uploaded: { label: "Uploaded", variant: "outline" },
  parsed: { label: "Parsed", variant: "secondary" },
  review: { label: "In Review", variant: "default" },
  importing: { label: "Importing…", variant: "default" },
  completed: { label: "Completed", variant: "secondary" },
  failed: { label: "Failed", variant: "destructive" },
};

const matchConfig: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  matched: { label: "Matched", variant: "default" },
  new: { label: "New", variant: "secondary" },
  ambiguous: { label: "Ambiguous", variant: "outline" },
  invalid: { label: "Invalid", variant: "destructive" },
  skipped: { label: "Skipped", variant: "outline" },
};

export function ImportStatusBadge({ status }: ImportStatusBadgeProps) {
  const config = statusConfig[status] || matchConfig[status] || { label: status, variant: "outline" as const };
  return <Badge variant={config.variant}>{config.label}</Badge>;
}

export function MatchStatusBadge({ status }: ImportStatusBadgeProps) {
  const config = matchConfig[status] || { label: status, variant: "outline" as const };
  return <Badge variant={config.variant}>{config.label}</Badge>;
}
