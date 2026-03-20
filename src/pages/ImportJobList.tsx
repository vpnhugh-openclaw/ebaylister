import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { ImportStatusBadge } from "@/components/imports/ImportStatusBadge";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Plus } from "lucide-react";
import { format } from "date-fns";

export default function ImportJobList() {
  const navigate = useNavigate();
  const { user } = useAuth();

  const { data: jobs, isLoading } = useQuery({
    queryKey: ["import-jobs"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("import_jobs")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return data;
    },
    enabled: !!user,
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Import Jobs</h1>
          <p className="text-muted-foreground">Manage supplier CSV imports</p>
        </div>
        <Button onClick={() => navigate("/imports/chemistwarehouse")}>
          <Plus className="mr-2 h-4 w-4" /> New CW Import
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>File</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="text-right">Matched</TableHead>
                <TableHead className="text-right">New</TableHead>
                <TableHead className="text-right">Ambiguous</TableHead>
                <TableHead className="text-right">Invalid</TableHead>
                <TableHead>Created</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={10} className="text-center py-8 text-muted-foreground">Loading…</TableCell></TableRow>
              ) : !jobs?.length ? (
                <TableRow><TableCell colSpan={10} className="text-center py-8 text-muted-foreground">No import jobs yet</TableCell></TableRow>
              ) : (
                jobs.map((job) => (
                  <TableRow key={job.id}>
                    <TableCell className="font-medium text-sm max-w-[200px] truncate">{job.file_name}</TableCell>
                    <TableCell className="text-sm">{job.source_name}</TableCell>
                    <TableCell><ImportStatusBadge status={job.status} /></TableCell>
                    <TableCell className="text-right">{job.total_rows}</TableCell>
                    <TableCell className="text-right">{job.matched_rows}</TableCell>
                    <TableCell className="text-right">{job.new_rows}</TableCell>
                    <TableCell className="text-right">{job.ambiguous_rows}</TableCell>
                    <TableCell className="text-right">{job.invalid_rows}</TableCell>
                    <TableCell className="text-sm">{format(new Date(job.created_at), "dd MMM yyyy HH:mm")}</TableCell>
                    <TableCell>
                      <Button size="sm" variant="outline" onClick={() => navigate(`/imports/${job.id}`)}>Open</Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
