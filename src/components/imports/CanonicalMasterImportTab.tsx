import { useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Upload, FileSpreadsheet, CheckCircle, AlertTriangle, ArrowRight,
  Plus, RefreshCw, SkipForward, Download, Image as ImageIcon,
} from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import {
  parseCanonicalMasterFile,
  canonicalRowToProductData,
  type CanonicalMasterRow,
  type CanonicalMasterParseResult,
} from "@/lib/imports/canonicalMaster/parser";
import { bulkProductUpsert, type BulkUpsertMode } from "@/lib/api/bulk-upsert";

type Stage = "upload" | "preview" | "importing" | "done";

interface MatchInfo {
  row: CanonicalMasterRow;
  matchType: "barcode" | "name" | "new";
  matchedProductId?: string;
}

interface Summary {
  matched: MatchInfo[];
  newRows: MatchInfo[];
  skipped: CanonicalMasterRow[];
}

interface ImportResult {
  newCount: number;
  updatedCount: number;
  skippedCount: number;
  errorCount: number;
  errors: string[];
  imagesInserted: number;
}

const PRODUCT_CHUNK = 1500;

export function CanonicalMasterImportTab() {
  const [stage, setStage] = useState<Stage>("upload");
  const [isDragging, setIsDragging] = useState(false);
  const [filename, setFilename] = useState("");
  const [parseResult, setParseResult] = useState<CanonicalMasterParseResult | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState("");
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [mode, setMode] = useState<BulkUpsertMode>("fill_blanks");
  const [importImages, setImportImages] = useState(true);

  const handleFile = useCallback(async (file: File) => {
    if (!file.name.match(/\.(xlsx|xls|csv)$/i)) {
      toast.error("Please upload an .xlsx, .xls, or .csv file");
      return;
    }
    setIsAnalyzing(true);
    setFilename(file.name);
    try {
      const result = await parseCanonicalMasterFile(file);
      setParseResult(result);
      const matchSummary = await analyzeMatches(result);
      setSummary(matchSummary);
      setStage("preview");
    } catch (err) {
      toast.error("Failed to parse file", { description: String(err) });
    }
    setIsAnalyzing(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  }, [handleFile]);

  async function analyzeMatches(result: CanonicalMasterParseResult): Promise<Summary> {
    // Pull a slim projection of all existing products. Use range to defeat the 1k cap.
    const barcodeMap = new Map<string, string>();
    const nameMap = new Map<string, string>();
    const PAGE = 1000;
    let from = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { data, error } = await supabase
        .from("products")
        .select("id, barcode, normalized_product_name")
        .range(from, from + PAGE - 1);
      if (error) throw error;
      if (!data || data.length === 0) break;
      for (const p of data) {
        if (p.barcode) barcodeMap.set(p.barcode, p.id);
        if (p.normalized_product_name && !nameMap.has(p.normalized_product_name)) {
          nameMap.set(p.normalized_product_name, p.id);
        }
      }
      if (data.length < PAGE) break;
      from += PAGE;
    }

    const matched: MatchInfo[] = [];
    const newRows: MatchInfo[] = [];
    const skipped: CanonicalMasterRow[] = [];

    for (const row of result.rows) {
      if (!row.source_product_name) {
        skipped.push(row);
        continue;
      }
      let id: string | undefined;
      let matchType: MatchInfo["matchType"] = "new";
      if (row.barcode && barcodeMap.has(row.barcode)) {
        id = barcodeMap.get(row.barcode);
        matchType = "barcode";
      } else if (row.normalized_product_name && nameMap.has(row.normalized_product_name)) {
        id = nameMap.get(row.normalized_product_name);
        matchType = "name";
      }
      if (id) matched.push({ row, matchType, matchedProductId: id });
      else newRows.push({ row, matchType: "new" });
    }
    return { matched, newRows, skipped };
  }

  const commitImport = async () => {
    if (!summary || !parseResult) return;
    setStage("importing");
    setProgress(2);
    setProgressLabel("Preparing payload…");

    const allRows: CanonicalMasterRow[] = [
      ...summary.matched.map((m) => m.row),
      ...summary.newRows.map((m) => m.row),
    ];

    let totalInserted = 0;
    let totalUpdated = 0;
    let totalSkipped = summary.skipped.length;
    let totalErrors = 0;
    const errors: string[] = [];

    try {
      // ── Phase 1: bulk upsert products in chunks ──
      const total = allRows.length;
      for (let i = 0; i < total; i += PRODUCT_CHUNK) {
        const chunk = allRows.slice(i, i + PRODUCT_CHUNK);
        const payloads = chunk.map((r) => canonicalRowToProductData(r));
        setProgressLabel(`Upserting products ${i + 1}–${Math.min(i + PRODUCT_CHUNK, total)} of ${total}…`);
        const res = await bulkProductUpsert(payloads, mode);
        if (!res.success) {
          throw new Error(res.errors[0] || "Bulk upsert failed");
        }
        totalInserted += res.inserted;
        totalUpdated += res.updated;
        totalSkipped += res.skipped;
        totalErrors += res.errors.length;
        if (res.errors.length > 0) errors.push(...res.errors.slice(0, 10));
        const pctProducts = ((i + chunk.length) / total) * (importImages ? 70 : 95);
        setProgress(Math.round(5 + pctProducts));
      }

      // ── Phase 2: insert images (best-effort) ──
      let imagesInserted = 0;
      if (importImages) {
        setProgressLabel("Linking product images…");
        imagesInserted = await insertImages(allRows, (done, all) => {
          setProgress(Math.round(75 + (done / Math.max(all, 1)) * 23));
        });
      }

      setProgress(100);
      setImportResult({
        newCount: totalInserted,
        updatedCount: totalUpdated,
        skippedCount: totalSkipped,
        errorCount: totalErrors,
        errors: errors.slice(0, 50),
        imagesInserted,
      });
      setStage("done");
      toast.success("Import complete", {
        description: `${totalInserted} new, ${totalUpdated} updated${importImages ? `, ${imagesInserted} images` : ""}`,
      });
    } catch (err: unknown) {
      setStage("preview");
      toast.error("Import failed", { description: String(err) });
    }
  };

  /**
   * Insert image URLs into product_images for products that have at least one
   * image_url and a barcode we can use to look up the product id.
   * Skips images that already exist for a product (matched by original_url).
   */
  async function insertImages(
    rows: CanonicalMasterRow[],
    onProgress: (done: number, all: number) => void,
  ): Promise<number> {
    const withImages = rows.filter((r) => r.image_urls.length > 0 && r.barcode);
    if (withImages.length === 0) return 0;

    // Look up product IDs by barcode (in chunks of 500)
    const barcodeToId = new Map<string, string>();
    const allBarcodes = withImages.map((r) => r.barcode!).filter((v, i, a) => a.indexOf(v) === i);
    for (let i = 0; i < allBarcodes.length; i += 500) {
      const slice = allBarcodes.slice(i, i + 500);
      const { data, error } = await supabase
        .from("products")
        .select("id, barcode")
        .in("barcode", slice);
      if (error) continue;
      for (const p of data || []) {
        if (p.barcode) barcodeToId.set(p.barcode, p.id);
      }
    }

    // Pull existing image URLs to avoid duplicates
    const productIds = Array.from(new Set(withImages.map((r) => barcodeToId.get(r.barcode!)).filter(Boolean) as string[]));
    const existing = new Set<string>();
    for (let i = 0; i < productIds.length; i += 200) {
      const slice = productIds.slice(i, i + 200);
      const { data } = await supabase
        .from("product_images")
        .select("product_id, original_url")
        .in("product_id", slice);
      for (const r of data || []) {
        if (r.original_url) existing.add(`${r.product_id}::${r.original_url}`);
      }
    }

    type ImageInsert = {
      product_id: string;
      original_url: string;
      sort_order: number;
      is_primary: boolean;
      source_type: string;
      image_status: string;
    };
    const inserts: ImageInsert[] = [];
    for (const row of withImages) {
      const productId = barcodeToId.get(row.barcode!);
      if (!productId) continue;
      row.image_urls.forEach((url, idx) => {
        const key = `${productId}::${url}`;
        if (existing.has(key)) return;
        existing.add(key);
        inserts.push({
          product_id: productId,
          original_url: url,
          sort_order: idx,
          is_primary: idx === 0,
          source_type: "canonical_master_import",
          image_status: "pending",
        });
      });
    }

    let inserted = 0;
    const CHUNK = 500;
    for (let i = 0; i < inserts.length; i += CHUNK) {
      const slice = inserts.slice(i, i + CHUNK);
      const { error } = await supabase.from("product_images").insert(slice);
      if (!error) inserted += slice.length;
      onProgress(i + slice.length, inserts.length);
    }
    return inserted;
  }

  const downloadErrorReport = () => {
    if (!summary) return;
    const errorRows = summary.skipped.map((r) => ({
      row: r.row_number,
      title: r.source_product_name || "",
      barcode: r.barcode || "",
      errors: r.validation_errors.map((e) => `${e.field}: ${e.message}`).join("; ") || "Missing required field",
    }));
    if (importResult?.errors) {
      for (const e of importResult.errors) {
        errorRows.push({ row: 0, title: "", barcode: "", errors: e });
      }
    }
    if (errorRows.length === 0) {
      toast.info("No errors to download");
      return;
    }
    const header = "Row,Title,Barcode,Errors\n";
    const csv = header + errorRows.map((r) =>
      [r.row, `"${r.title.replace(/"/g, '""')}"`, r.barcode, `"${r.errors.replace(/"/g, '""')}"`].join(",")
    ).join("\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `canonical-master-errors-${new Date().toISOString().split("T")[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const reset = () => {
    setStage("upload");
    setParseResult(null);
    setSummary(null);
    setImportResult(null);
    setProgress(0);
    setProgressLabel("");
  };

  const totalToImport = (summary?.matched.length || 0) + (summary?.newRows.length || 0);

  return (
    <div className="space-y-4">
      {/* Stage indicator */}
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {["Upload", "Preview & Match", "Import", "Done"].map((label, i) => {
          const stages: Stage[] = ["upload", "preview", "importing", "done"];
          const isActive = stages.indexOf(stage) >= i;
          return (
            <div key={label} className="flex items-center gap-2">
              {i > 0 && <ArrowRight className="h-3 w-3 text-muted-foreground/40" />}
              <span className={isActive ? "font-medium text-foreground" : "opacity-50"}>{label}</span>
            </div>
          );
        })}
      </div>

      {/* UPLOAD */}
      {stage === "upload" && (
        <Card
          className={`border-2 border-dashed transition-colors ${isDragging ? "border-primary bg-primary/5" : "border-border"}`}
          onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
        >
          <CardContent className="py-16 text-center">
            {isAnalyzing ? (
              <>
                <RefreshCw className="h-12 w-12 mx-auto mb-4 text-primary animate-spin" />
                <p className="font-medium">Parsing & analyzing…</p>
                <p className="text-xs text-muted-foreground mt-1">Large files (20k+ rows) may take a minute</p>
              </>
            ) : (
              <>
                <Upload className="h-12 w-12 mx-auto mb-4 text-muted-foreground opacity-40" />
                <p className="font-medium mb-1">Drop the canonical master spreadsheet here</p>
                <p className="text-sm text-muted-foreground mb-4">
                  Expected columns: Barcode, Product Name, Vendor, Category, Tags, Description_HTML, Sell Price, RRP, Weight, Image_1…5, Product_URL
                </p>
                <label>
                  <Button variant="outline" asChild><span>Browse Files</span></Button>
                  <input type="file" className="hidden" accept=".xlsx,.xls,.csv" onChange={handleFileInput} />
                </label>
              </>
            )}
          </CardContent>
        </Card>
      )}

      {/* PREVIEW */}
      {stage === "preview" && summary && parseResult && (
        <div className="space-y-4">
          {/* File info */}
          <Card>
            <CardContent className="py-3 flex flex-wrap items-center gap-3">
              <FileSpreadsheet className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">{filename}</span>
              <div className="flex-1" />
              <span className="text-[10px] text-muted-foreground">
                Total rows: <strong className="text-foreground">{parseResult.totalRawRows.toLocaleString()}</strong>
              </span>
            </CardContent>
          </Card>

          {/* Warnings */}
          {parseResult.warnings.length > 0 && (
            <Card className="border-amber-300/30 bg-amber-50/50 dark:bg-amber-950/20">
              <CardContent className="py-3">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
                  <div className="text-xs space-y-0.5">
                    {parseResult.warnings.map((w, i) => <p key={i}>{w}</p>)}
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Header mapping */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Column Mapping</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(parseResult.mappedHeaders).map(([raw, canonical]) => (
                  <Badge key={raw} variant="outline" className="text-[10px] font-mono">
                    {raw} → {canonical}
                  </Badge>
                ))}
              </div>
              {parseResult.unmappedHeaders.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {parseResult.unmappedHeaders.map((h) => (
                    <Badge key={h} variant="secondary" className="text-[10px] font-mono text-muted-foreground">
                      {h} (ignored)
                    </Badge>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Summary */}
          <div className="grid grid-cols-3 gap-3">
            <SummaryCard label="New Products" count={summary.newRows.length} icon={<Plus className="h-4 w-4" />} color="text-emerald-600 dark:text-emerald-400" />
            <SummaryCard label="Existing Matches" count={summary.matched.length} icon={<RefreshCw className="h-4 w-4" />} color="text-primary" />
            <SummaryCard label="Skipped (no name)" count={summary.skipped.length} icon={<SkipForward className="h-4 w-4" />} color="text-muted-foreground" />
          </div>

          {/* Options */}
          <Card>
            <CardContent className="pt-4 pb-4 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <Label className="text-sm">Update mode for matched products</Label>
                  <p className="text-[11px] text-muted-foreground">
                    {mode === "fill_blanks"
                      ? "Only populate fields currently empty (curated data preserved)."
                      : "Replace existing values with spreadsheet values."}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`text-xs ${mode === "fill_blanks" ? "font-medium" : "text-muted-foreground"}`}>Fill blanks</span>
                  <Switch
                    checked={mode === "overwrite"}
                    onCheckedChange={(v) => setMode(v ? "overwrite" : "fill_blanks")}
                  />
                  <span className={`text-xs ${mode === "overwrite" ? "font-medium" : "text-muted-foreground"}`}>Overwrite</span>
                </div>
              </div>
              <div className="flex items-center justify-between border-t pt-3">
                <div className="flex items-center gap-2">
                  <ImageIcon className="h-4 w-4 text-muted-foreground" />
                  <div>
                    <Label className="text-sm">Import product images</Label>
                    <p className="text-[11px] text-muted-foreground">
                      Adds Image_1…5 URLs to product_images (skips existing).
                    </p>
                  </div>
                </div>
                <Switch checked={importImages} onCheckedChange={setImportImages} />
              </div>
            </CardContent>
          </Card>

          {/* Sample preview */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Preview (first 100 rows)</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto max-h-[400px]">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-[10px]">Row</TableHead>
                      <TableHead className="text-[10px] min-w-[220px]">Product</TableHead>
                      <TableHead className="text-[10px]">Brand</TableHead>
                      <TableHead className="text-[10px]">Barcode</TableHead>
                      <TableHead className="text-[10px]">Price</TableHead>
                      <TableHead className="text-[10px]">RRP</TableHead>
                      <TableHead className="text-[10px]">Imgs</TableHead>
                      <TableHead className="text-[10px]">Match</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {parseResult.rows.slice(0, 100).map((row) => {
                      const m = summary.matched.find((x) => x.row.row_number === row.row_number);
                      const isSkipped = summary.skipped.some((s) => s.row_number === row.row_number);
                      return (
                        <TableRow key={row.row_number} className={isSkipped ? "opacity-50" : ""}>
                          <TableCell className="text-[10px] font-mono text-muted-foreground">{row.row_number}</TableCell>
                          <TableCell className="text-[10px] max-w-[280px] truncate">{row.source_product_name || "—"}</TableCell>
                          <TableCell className="text-[10px]">{row.brand || "—"}</TableCell>
                          <TableCell className="text-[10px] font-mono">{row.barcode || "—"}</TableCell>
                          <TableCell className="text-[10px]">{row.sell_price != null ? `$${row.sell_price.toFixed(2)}` : "—"}</TableCell>
                          <TableCell className="text-[10px]">{row.shopify_listed_price != null ? `$${row.shopify_listed_price.toFixed(2)}` : "—"}</TableCell>
                          <TableCell className="text-[10px]">{row.image_urls.length || "—"}</TableCell>
                          <TableCell className="text-[10px]">
                            {isSkipped ? (
                              <Badge variant="secondary" className="text-[9px]">skip</Badge>
                            ) : m ? (
                              <Badge variant="outline" className="text-[9px]">{m.matchType}</Badge>
                            ) : (
                              <Badge className="text-[9px] bg-emerald-600">new</Badge>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>

          {/* Actions */}
          <div className="flex gap-3 justify-end">
            <Button variant="outline" onClick={reset}>Cancel</Button>
            <Button onClick={commitImport} disabled={totalToImport === 0}>
              Commit Import ({totalToImport.toLocaleString()} products)
            </Button>
          </div>
        </div>
      )}

      {/* IMPORTING */}
      {stage === "importing" && (
        <Card>
          <CardContent className="py-12 space-y-4">
            <Progress value={progress} />
            <p className="text-sm text-muted-foreground text-center">
              {progressLabel || `Importing… ${progress}%`}
            </p>
            <p className="text-[10px] text-muted-foreground/70 text-center">
              Don't close this tab — large imports can take several minutes.
            </p>
          </CardContent>
        </Card>
      )}

      {/* DONE */}
      {stage === "done" && importResult && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base text-emerald-600 dark:text-emerald-400">
              <CheckCircle className="h-5 w-5" /> Import Complete
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              <StatCard label="New" value={importResult.newCount} color="text-emerald-600 dark:text-emerald-400" />
              <StatCard label="Updated" value={importResult.updatedCount} color="text-primary" />
              <StatCard label="Skipped" value={importResult.skippedCount} color="text-muted-foreground" />
              <StatCard label="Images" value={importResult.imagesInserted} color="text-violet-600 dark:text-violet-400" />
              <StatCard label="Errors" value={importResult.errorCount} color="text-destructive" />
            </div>
            {importResult.errors.length > 0 && (
              <div className="text-xs bg-destructive/10 rounded p-3 max-h-[150px] overflow-y-auto space-y-1">
                {importResult.errors.map((e, i) => <div key={i}>{e}</div>)}
              </div>
            )}
            <div className="flex gap-3">
              <Button variant="outline" onClick={reset}>Import Another File</Button>
              <Button variant="outline" size="sm" onClick={downloadErrorReport}>
                <Download className="h-3.5 w-3.5 mr-1.5" /> Error Report
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function SummaryCard({ label, count, icon, color }: { label: string; count: number; icon: React.ReactNode; color: string }) {
  return (
    <Card>
      <CardContent className="pt-4 pb-3">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className={`text-2xl font-bold mt-0.5 ${color}`}>{count.toLocaleString()}</p>
          </div>
          <div className={`${color} opacity-50`}>{icon}</div>
        </div>
      </CardContent>
    </Card>
  );
}

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="text-center p-3 border rounded-lg">
      <div className={`text-2xl font-bold ${color}`}>{value.toLocaleString()}</div>
      <div className="text-xs text-muted-foreground mt-1">{label}</div>
    </div>
  );
}
