import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Upload, FileSpreadsheet, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { parseChemistWarehouseCSV } from "@/lib/imports/chemistwarehouse/parser";
import { matchImportRow } from "@/lib/imports/chemistwarehouse/match";
import { toast } from "@/hooks/use-toast";

export default function ImportChemistWarehouse() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [file, setFile] = useState<File | null>(null);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState({ stage: "", current: 0, total: 0 });

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] || null;
    if (f && !f.name.endsWith(".csv")) {
      toast({ title: "Invalid file", description: "Please upload a CSV file", variant: "destructive" });
      return;
    }
    setFile(f);
  };

  const handleUpload = async () => {
    if (!file || !user) return;
    setProcessing(true);

    try {
      // 1. Parse CSV
      setProgress({ stage: "Parsing CSV…", current: 0, total: 0 });
      const parsedRows = await parseChemistWarehouseCSV(file);
      if (parsedRows.length === 0) {
        toast({ title: "No data found", description: "CSV appears empty", variant: "destructive" });
        setProcessing(false);
        return;
      }

      setProgress({ stage: "Creating import job…", current: 0, total: parsedRows.length });

      // 2. Create import_job
      const { data: job, error: jobErr } = await supabase
        .from("import_jobs")
        .insert({
          source_name: "chemistwarehouse",
          file_name: file.name,
          status: "uploaded",
          total_rows: parsedRows.length,
          created_by: user.id,
        })
        .select("id")
        .single();

      if (jobErr || !job) throw new Error(jobErr?.message || "Failed to create job");

      // 3. Match rows (batch of 10 for progress feedback)
      setProgress({ stage: "Matching products…", current: 0, total: parsedRows.length });
      const matchedRows = [];
      for (let i = 0; i < parsedRows.length; i++) {
        const matchResult = await matchImportRow(parsedRows[i], supabase);
        matchedRows.push({ ...parsedRows[i], ...matchResult });
        if (i % 10 === 0) {
          setProgress({ stage: "Matching products…", current: i + 1, total: parsedRows.length });
        }
      }

      // 4. Bulk insert import_rows in batches of 100
      setProgress({ stage: "Saving rows…", current: 0, total: matchedRows.length });
      const BATCH_SIZE = 100;
      for (let i = 0; i < matchedRows.length; i += BATCH_SIZE) {
        const batch = matchedRows.slice(i, i + BATCH_SIZE).map((r) => ({
          import_job_id: job.id,
          row_number: r.row_number,
          source_name: "chemistwarehouse",
          raw_data: r.raw_data,
          source_url: r.source_url,
          source_product_id: r.source_product_id,
          source_sku: r.source_sku,
          source_slug: r.source_slug,
          source_name_raw: r.source_name_raw,
          source_brand: r.source_brand,
          source_current_price: r.source_current_price,
          source_rrp: r.source_rrp,
          source_currency: r.source_currency,
          source_in_stock: r.source_in_stock,
          source_category_path: r.source_category_path,
          source_image_url: r.source_image_url,
          source_review_rating: r.source_review_rating,
          source_review_count: r.source_review_count,
          source_updated_at: r.source_updated_at,
          source_meta_json: r.source_meta_json,
          normalized_name: r.normalized_name,
          normalized_brand: r.normalized_brand,
          normalized_slug: r.normalized_slug,
          validation_errors: r.validation_errors,
          match_status: r.match_status,
          match_method: r.match_method,
          match_confidence: r.match_confidence,
          matched_product_id: r.matched_product_id,
          candidate_matches: r.candidate_matches,
          // Auto-set resolution for clear matches and new
          resolution_action: r.match_status === "matched" ? "update" :
                           r.match_status === "new" ? "create" :
                           r.match_status === "invalid" ? "skip" : null,
        }));

        const { error: insertErr } = await supabase.from("import_rows").insert(batch);
        if (insertErr) {
          console.error("Batch insert error:", insertErr);
        }
        setProgress({ stage: "Saving rows…", current: Math.min(i + BATCH_SIZE, matchedRows.length), total: matchedRows.length });
      }

      // 5. Update job status and counts
      const counts = {
        matched: matchedRows.filter((r) => r.match_status === "matched").length,
        new: matchedRows.filter((r) => r.match_status === "new").length,
        ambiguous: matchedRows.filter((r) => r.match_status === "ambiguous").length,
        invalid: matchedRows.filter((r) => r.match_status === "invalid").length,
        skipped: matchedRows.filter((r) => r.match_status === "skipped").length,
      };

      await supabase.from("import_jobs").update({
        status: "review",
        matched_rows: counts.matched,
        new_rows: counts.new,
        ambiguous_rows: counts.ambiguous,
        invalid_rows: counts.invalid,
        skipped_rows: counts.skipped,
      }).eq("id", job.id);

      toast({ title: "Import staged", description: `${parsedRows.length} rows parsed. ${counts.ambiguous} need review.` });
      navigate(`/imports/${job.id}`);
    } catch (err) {
      toast({ title: "Import failed", description: String(err), variant: "destructive" });
    } finally {
      setProcessing(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Import Chemist Warehouse CSV</h1>
        <p className="text-muted-foreground">Upload a Chemist Warehouse scraper CSV to stage, review, and import products.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Upload File</CardTitle>
          <CardDescription>Accepts .csv files from the Chemist Warehouse scraper</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-4">
            <div className="flex-1">
              <Input type="file" accept=".csv" onChange={handleFileChange} disabled={processing} />
            </div>
            {file && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <FileSpreadsheet className="h-4 w-4" />
                {file.name}
              </div>
            )}
          </div>

          {processing && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm">
                <Loader2 className="h-4 w-4 animate-spin" />
                {progress.stage}
                {progress.total > 0 && (
                  <span className="text-muted-foreground">
                    ({progress.current} / {progress.total})
                  </span>
                )}
              </div>
              {progress.total > 0 && (
                <div className="h-2 w-full rounded-full bg-muted">
                  <div
                    className="h-2 rounded-full bg-primary transition-all"
                    style={{ width: `${(progress.current / progress.total) * 100}%` }}
                  />
                </div>
              )}
            </div>
          )}

          <Button onClick={handleUpload} disabled={!file || processing}>
            <Upload className="mr-2 h-4 w-4" />
            Upload and Analyse
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Supported Columns</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2 text-xs">
            {["url", "product_id", "sku", "slug", "name", "brand", "current_price", "current_rrp",
              "currency_code", "in_stock", "category_path", "image_url", "review_rating",
              "review_count", "raw_json_path", "source", "updated_at", "meta_json"].map((col) => (
              <code key={col} className="rounded bg-muted px-1.5 py-0.5">{col}</code>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
