import { useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { MatchStatusBadge, ImportStatusBadge } from "@/components/imports/ImportStatusBadge";
import { ImportRowReviewDrawer } from "@/components/imports/ImportRowReviewDrawer";
import { ImportCommitPanel } from "@/components/imports/ImportCommitPanel";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Search, ChevronLeft, ChevronRight } from "lucide-react";

const PAGE_SIZE = 50;

export default function ImportJobDetail() {
  const { jobId } = useParams<{ jobId: string }>();
  const { user } = useAuth();
  const [statusFilter, setStatusFilter] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(0);
  const [selectedRow, setSelectedRow] = useState<string | null>(null);

  const { data: job, refetch: refetchJob } = useQuery({
    queryKey: ["import-job", jobId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("import_jobs")
        .select("*")
        .eq("id", jobId!)
        .single();
      if (error) throw error;
      return data;
    },
    enabled: !!jobId && !!user,
  });

  const { data: rowsResult, refetch: refetchRows } = useQuery({
    queryKey: ["import-rows", jobId, statusFilter, searchQuery, page],
    queryFn: async () => {
      let query = supabase
        .from("import_rows")
        .select("*", { count: "exact" })
        .eq("import_job_id", jobId!)
        .order("row_number");

      if (statusFilter !== "all") {
        query = query.eq("match_status", statusFilter);
      }
      if (searchQuery.trim()) {
        query = query.or(`source_name_raw.ilike.%${searchQuery}%,source_sku.ilike.%${searchQuery}%,source_url.ilike.%${searchQuery}%`);
      }

      const from = page * PAGE_SIZE;
      query = query.range(from, from + PAGE_SIZE - 1);

      const { data, error, count } = await query;
      if (error) throw error;
      return { rows: data || [], total: count || 0 };
    },
    enabled: !!jobId && !!user,
  });

  const rows = rowsResult?.rows || [];
  const totalRows = rowsResult?.total || 0;
  const totalPages = Math.ceil(totalRows / PAGE_SIZE);

  const selectedRowData = rows.find((r) => r.id === selectedRow);

  const handleRefresh = () => {
    refetchJob();
    refetchRows();
  };

  if (!job) return <div className="p-8 text-center text-muted-foreground">Loading…</div>;

  const statCards = [
    { label: "Total", value: job.total_rows, color: "text-foreground" },
    { label: "Matched", value: job.matched_rows, color: "text-blue-600" },
    { label: "New", value: job.new_rows, color: "text-emerald-600" },
    { label: "Ambiguous", value: job.ambiguous_rows, color: "text-amber-600" },
    { label: "Invalid", value: job.invalid_rows, color: "text-destructive" },
    { label: "Skipped", value: job.skipped_rows, color: "text-muted-foreground" },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">{job.file_name}</h1>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <ImportStatusBadge status={job.status} />
            <span>{job.source_name}</span>
          </div>
        </div>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-6 gap-3">
        {statCards.map((s) => (
          <Card key={s.label}>
            <CardContent className="p-3 text-center">
              <div className={`text-2xl font-bold ${s.color}`}>{s.value}</div>
              <div className="text-xs text-muted-foreground">{s.label}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Filters */}
      <div className="flex items-center gap-4">
        <Tabs value={statusFilter} onValueChange={(v) => { setStatusFilter(v); setPage(0); }}>
          <TabsList>
            <TabsTrigger value="all">All</TabsTrigger>
            <TabsTrigger value="matched">Matched</TabsTrigger>
            <TabsTrigger value="new">New</TabsTrigger>
            <TabsTrigger value="ambiguous">Ambiguous</TabsTrigger>
            <TabsTrigger value="invalid">Invalid</TabsTrigger>
            <TabsTrigger value="skipped">Skipped</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search name, SKU, URL…"
            className="pl-8"
            value={searchQuery}
            onChange={(e) => { setSearchQuery(e.target.value); setPage(0); }}
          />
        </div>
      </div>

      {/* Rows table */}
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12">#</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Brand</TableHead>
                <TableHead>SKU</TableHead>
                <TableHead className="text-right">Price</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Method</TableHead>
                <TableHead className="text-right">Conf.</TableHead>
                <TableHead>Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} className="py-8 text-center text-muted-foreground">No rows found</TableCell>
                </TableRow>
              ) : (
                rows.map((row) => (
                  <TableRow
                    key={row.id}
                    className="cursor-pointer hover:bg-muted/50"
                    onClick={() => setSelectedRow(row.id)}
                  >
                    <TableCell className="text-xs text-muted-foreground">{row.row_number}</TableCell>
                    <TableCell className="text-sm max-w-[250px] truncate">{row.source_name_raw || "—"}</TableCell>
                    <TableCell className="text-sm">{row.source_brand || "—"}</TableCell>
                    <TableCell className="text-xs font-mono">{row.source_sku || "—"}</TableCell>
                    <TableCell className="text-sm text-right">
                      {row.source_current_price != null ? `$${Number(row.source_current_price).toFixed(2)}` : "—"}
                    </TableCell>
                    <TableCell><MatchStatusBadge status={row.match_status} /></TableCell>
                    <TableCell className="text-xs text-muted-foreground">{row.match_method || "—"}</TableCell>
                    <TableCell className="text-right text-xs">
                      {row.match_confidence != null ? `${(Number(row.match_confidence) * 100).toFixed(0)}%` : "—"}
                    </TableCell>
                    <TableCell className="text-xs">{row.resolution_action || "—"}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">
            Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, totalRows)} of {totalRows}
          </span>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage(page - 1)}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="text-sm">Page {page + 1} of {totalPages}</span>
            <Button size="sm" variant="outline" disabled={page >= totalPages - 1} onClick={() => setPage(page + 1)}>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Review drawer */}
      <ImportRowReviewDrawer
        row={selectedRowData ? {
          ...selectedRowData,
          source_current_price: selectedRowData.source_current_price ? Number(selectedRowData.source_current_price) : null,
          source_rrp: selectedRowData.source_rrp ? Number(selectedRowData.source_rrp) : null,
          match_confidence: selectedRowData.match_confidence ? Number(selectedRowData.match_confidence) : null,
          candidate_matches: (selectedRowData.candidate_matches as Array<{ product_id: string; name: string; score: number; method: string }>) || [],
          validation_errors: (selectedRowData.validation_errors as Array<{ field: string; message: string }>) || [],
        } : null}
        open={!!selectedRow}
        onClose={() => setSelectedRow(null)}
        onResolved={handleRefresh}
      />

      {/* Commit panel */}
      {job.status === "review" && (
        <ImportCommitPanel
          jobId={job.id}
          matchedCount={job.matched_rows}
          newCount={job.new_rows}
          ambiguousCount={job.ambiguous_rows}
          skippedCount={job.skipped_rows}
          totalRows={job.total_rows}
          onCommitted={handleRefresh}
        />
      )}
    </div>
  );
}
