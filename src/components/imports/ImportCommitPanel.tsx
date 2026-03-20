import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, CheckCircle2, AlertTriangle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { commitImportJob, type CommitResult } from "@/lib/imports/chemistwarehouse/commit";
import { toast } from "@/hooks/use-toast";

interface ImportCommitPanelProps {
  jobId: string;
  matchedCount: number;
  newCount: number;
  ambiguousCount: number;
  skippedCount: number;
  totalRows: number;
  onCommitted: () => void;
}

export function ImportCommitPanel({
  jobId,
  matchedCount,
  newCount,
  ambiguousCount,
  skippedCount,
  totalRows,
  onCommitted,
}: ImportCommitPanelProps) {
  const [committing, setCommitting] = useState(false);
  const [result, setResult] = useState<CommitResult | null>(null);

  const toUpdate = matchedCount;
  const toCreate = newCount;
  const toSkip = skippedCount;
  const unresolved = ambiguousCount;
  const canCommit = unresolved === 0 && (toUpdate + toCreate) > 0;

  const handleCommit = async () => {
    setCommitting(true);
    try {
      const commitResult = await commitImportJob(jobId, supabase);
      setResult(commitResult);
      toast({
        title: "Import completed",
        description: `Created: ${commitResult.created}, Updated: ${commitResult.updated}, Skipped: ${commitResult.skipped}`,
      });
      onCommitted();
    } catch (err) {
      toast({ title: "Import failed", description: String(err), variant: "destructive" });
    } finally {
      setCommitting(false);
    }
  };

  if (result) {
    return (
      <Card className="border-t-2 border-t-primary">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <CheckCircle2 className="h-5 w-5 text-emerald-600" />
            Import Complete
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-4 gap-4 text-center">
            <div>
              <div className="text-2xl font-bold text-emerald-600">{result.created}</div>
              <div className="text-xs text-muted-foreground">Created</div>
            </div>
            <div>
              <div className="text-2xl font-bold text-blue-600">{result.updated}</div>
              <div className="text-xs text-muted-foreground">Updated</div>
            </div>
            <div>
              <div className="text-2xl font-bold text-muted-foreground">{result.skipped}</div>
              <div className="text-xs text-muted-foreground">Skipped</div>
            </div>
            <div>
              <div className="text-2xl font-bold text-destructive">{result.failed}</div>
              <div className="text-xs text-muted-foreground">Failed</div>
            </div>
          </div>
          {result.errors.length > 0 && (
            <div className="mt-4 max-h-32 overflow-y-auto rounded border p-2 text-xs">
              {result.errors.map((e, i) => (
                <div key={i} className="text-destructive">Row {e.row_number}: {e.error}</div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="sticky bottom-0 border-t-2 border-t-primary bg-background shadow-lg">
      <CardContent className="flex items-center justify-between py-4">
        <div className="flex gap-6 text-sm">
          <span>To update: <strong>{toUpdate}</strong></span>
          <span>To create: <strong>{toCreate}</strong></span>
          <span>To skip: <strong>{toSkip}</strong></span>
          {unresolved > 0 && (
            <span className="flex items-center gap-1 text-amber-600">
              <AlertTriangle className="h-3.5 w-3.5" />
              Unresolved: <strong>{unresolved}</strong>
            </span>
          )}
        </div>
        <Button onClick={handleCommit} disabled={!canCommit || committing}>
          {committing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {committing ? "Importing…" : `Apply Import (${toUpdate + toCreate} products)`}
        </Button>
      </CardContent>
    </Card>
  );
}
