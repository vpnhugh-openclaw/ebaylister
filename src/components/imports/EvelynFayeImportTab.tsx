import { useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Upload, FileSpreadsheet, CheckCircle, AlertTriangle, ArrowRight,
  Plus, RefreshCw, SkipForward, Download,
} from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import {
  parseEvelynFayeCSV,
  evelynFayeRowToProductData,
  type EvelynFayeParsedRow,
  type EvelynFayeParseResult,
} from "@/lib/imports/evelynfaye/parser";
import { normalizeName, nameSimilarity, NAME_MATCH_THRESHOLD } from "@/lib/fos-parser";

type Stage = "upload" | "preview" | "importing" | "done";

interface MatchedRow {
  row: EvelynFayeParsedRow;
  productData: Record<string, unknown>;
  matchType: "barcode" | "sku" | "name_variant" | "new";
  matchedProductId?: string;
  existingProduct?: Record<string, unknown>;
}

interface Summary {
  newRows: MatchedRow[];
  updateRows: MatchedRow[];
  skippedRows: EvelynFayeParsedRow[];
}

interface ImportResult {
  newCount: number;
  updatedCount: number;
  skippedCount: number;
  errorCount: number;
  errors: string[];
}

export function EvelynFayeImportTab() {
  const [stage, setStage] = useState<Stage>("upload");
  const [isDragging, setIsDragging] = useState(false);
  const [filename, setFilename] = useState("");
  const [parseResult, setParseResult] = useState<EvelynFayeParseResult | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);

  const handleFile = useCallback(async (file: File) => {
    if (!file.name.match(/\.csv$/i)) {
      toast.error("Please upload a CSV file");
      return;
    }
    setIsAnalyzing(true);
    setFilename(file.name);
    try {
      const result = await parseEvelynFayeCSV(file);
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

  async function analyzeMatches(result: EvelynFayeParseResult): Promise<Summary> {
    const { data: existingProducts } = await supabase
      .from("products")
      .select("id, barcode, sku, source_product_name, normalized_product_name, brand, variant, sell_price, cost_price");

    const products = existingProducts || [];
    const barcodeMap = new Map<string, (typeof products)[0]>();
    const skuMap = new Map<string, (typeof products)[0]>();

    for (const p of products) {
      if (p.barcode) barcodeMap.set(p.barcode, p);
      if (p.sku) skuMap.set(p.sku, p);
    }

    const newRows: MatchedRow[] = [];
    const updateRows: MatchedRow[] = [];
    const skippedRows: EvelynFayeParsedRow[] = [];

    for (const row of result.rows) {
      if (row.validation_errors.some((e) => e.field === "title")) {
        skippedRows.push(row);
        continue;
      }

      const productData = evelynFayeRowToProductData(row);
      let matched: (typeof products)[0] | null = null;
      let matchType: MatchedRow["matchType"] = "new";

      // 1. Barcode match
      if (row.barcode && barcodeMap.has(row.barcode)) {
        matched = barcodeMap.get(row.barcode)!;
        matchType = "barcode";
      }

      // 2. SKU match
      if (!matched && row.sku && skuMap.has(row.sku)) {
        matched = skuMap.get(row.sku)!;
        matchType = "sku";
      }

      // 3. Title + variant + brand composite match
      if (!matched && row.source_product_name) {
        const composite = [row.source_product_name, row.variant, row.brand]
          .filter(Boolean).join(" ").toLowerCase().trim();
        const incomingNorm = normalizeName(composite);

        let bestMatch: (typeof products)[0] | null = null;
        let bestScore = 0;
        for (const p of products) {
          const existing = [p.source_product_name, p.variant, p.brand]
            .filter(Boolean).join(" ").toLowerCase().trim();
          const existingNorm = normalizeName(existing);
          const score = nameSimilarity(incomingNorm, existingNorm);
          if (score > bestScore) {
            bestScore = score;
            bestMatch = p;
          }
        }

        if (bestScore >= NAME_MATCH_THRESHOLD && bestMatch) {
          matched = bestMatch;
          matchType = "name_variant";
        }
      }

      if (matched) {
        updateRows.push({
          row, productData, matchType,
          matchedProductId: matched.id,
          existingProduct: matched as Record<string, unknown>,
        });
      } else {
        newRows.push({ row, productData, matchType: "new" });
      }
    }

    return { newRows, updateRows, skippedRows };
  }

  const commitImport = async () => {
    if (!summary || !parseResult) return;
    setStage("importing");
    setIsImporting(true);
    setProgress(10);

    const rows = [
      ...summary.newRows.map((r) => ({
        action: "insert" as const,
        productData: r.productData,
        sheetRow: r.row.row_number,
      })),
      ...summary.updateRows.map((r) => ({
        action: "update" as const,
        productData: r.productData,
        matchedProductId: r.matchedProductId,
        sheetRow: r.row.row_number,
      })),
    ];

    try {
      setProgress(30);
      const res = await supabase.functions.invoke("import-commit", {
        body: {
          filename,
          rows,
          totalValid: parseResult.rows.length,
          skippedCount: summary.skippedRows.length,
          firstProductRow: 1,
          footerRowsRemoved: 0,
        },
      });
      setProgress(90);

      if (res.error) throw new Error(res.error.message);
      if (res.data?.error) throw new Error(res.data.error);

      const data = res.data;
      setImportResult({
        newCount: data.newCount || 0,
        updatedCount: data.updatedCount || 0,
        skippedCount: data.skippedCount || 0,
        errorCount: data.errorCount || 0,
        errors: data.errors || [],
      });
      setProgress(100);
      setIsImporting(false);
      setStage("done");
      toast.success("Import complete", {
        description: `${data.newCount || 0} new, ${data.updatedCount || 0} updated`,
      });
    } catch (err: unknown) {
      setIsImporting(false);
      setStage("preview");
      toast.error("Import failed", { description: String(err) });
    }
  };

  const downloadErrorReport = () => {
    if (!summary) return;
    const errorRows = [
      ...summary.skippedRows.map((r) => ({
        row: r.row_number,
        title: r.source_product_name || "",
        sku: r.sku || "",
        barcode: r.barcode || "",
        errors: r.validation_errors.map((e) => `${e.field}: ${e.message}`).join("; "),
        status: "skipped",
      })),
    ];
    if (importResult?.errors) {
      for (const e of importResult.errors) {
        errorRows.push({ row: 0, title: "", sku: "", barcode: "", errors: e, status: "failed" });
      }
    }
    if (errorRows.length === 0) {
      toast.info("No errors to download");
      return;
    }
    const header = "Row,Title,SKU,Barcode,Errors,Status\n";
    const csv = header + errorRows.map((r) =>
      [r.row, `"${r.title}"`, r.sku, r.barcode, `"${r.errors}"`, r.status].join(",")
    ).join("\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `evelyn-faye-errors-${new Date().toISOString().split("T")[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const reset = () => {
    setStage("upload");
    setParseResult(null);
    setSummary(null);
    setImportResult(null);
    setProgress(0);
  };

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
              </>
            ) : (
              <>
                <Upload className="h-12 w-12 mx-auto mb-4 text-muted-foreground opacity-40" />
                <p className="font-medium mb-1">Drop your Evelyn Faye CSV here</p>
                <p className="text-sm text-muted-foreground mb-4">
                  Supports title, variant_title, brand, product_type, tags, sku, barcode, price, compare_at_price, weight, options, image, description
                </p>
                <label>
                  <Button variant="outline" asChild><span>Browse Files</span></Button>
                  <input type="file" className="hidden" accept=".csv" onChange={handleFileInput} />
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
                Rows: <strong className="text-foreground">{parseResult.rows.length}</strong>
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

          {/* Summary cards */}
          <div className="grid grid-cols-3 gap-3">
            <SummaryCard label="New Products" count={summary.newRows.length} icon={<Plus className="h-4 w-4" />} color="text-emerald-600 dark:text-emerald-400" />
            <SummaryCard label="Updates" count={summary.updateRows.length} icon={<RefreshCw className="h-4 w-4" />} color="text-primary" />
            <SummaryCard label="Skipped" count={summary.skippedRows.length} icon={<SkipForward className="h-4 w-4" />} color="text-muted-foreground" />
          </div>

          {/* Sample preview table */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Preview (first 100 rows)</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto max-h-[400px]">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-[10px]">#</TableHead>
                      <TableHead className="text-[10px] min-w-[200px]">Title</TableHead>
                      <TableHead className="text-[10px]">Variant</TableHead>
                      <TableHead className="text-[10px]">Brand</TableHead>
                      <TableHead className="text-[10px]">SKU</TableHead>
                      <TableHead className="text-[10px]">Barcode</TableHead>
                      <TableHead className="text-[10px]">Price</TableHead>
                      <TableHead className="text-[10px]">RRP</TableHead>
                      <TableHead className="text-[10px]">Weight</TableHead>
                      <TableHead className="text-[10px]">Type</TableHead>
                      <TableHead className="text-[10px]">Match</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {parseResult.rows.slice(0, 100).map((row, i) => {
                      const match = summary.updateRows.find((m) => m.row.row_number === row.row_number);
                      const isSkipped = summary.skippedRows.some((s) => s.row_number === row.row_number);
                      return (
                        <TableRow key={i} className={isSkipped ? "opacity-50" : ""}>
                          <TableCell className="text-[10px] font-mono text-muted-foreground">{row.row_number}</TableCell>
                          <TableCell className="text-[10px] max-w-[250px] truncate">{row.source_product_name || "—"}</TableCell>
                          <TableCell className="text-[10px]">{row.variant || "—"}</TableCell>
                          <TableCell className="text-[10px]">{row.brand || "—"}</TableCell>
                          <TableCell className="text-[10px] font-mono">{row.sku || "—"}</TableCell>
                          <TableCell className="text-[10px] font-mono">{row.barcode || "—"}</TableCell>
                          <TableCell className="text-[10px]">{row.sell_price != null ? `$${row.sell_price.toFixed(2)}` : "—"}</TableCell>
                          <TableCell className="text-[10px]">{row.cost_price != null ? `$${row.cost_price.toFixed(2)}` : "—"}</TableCell>
                          <TableCell className="text-[10px]">{row.weight_grams != null ? `${row.weight_grams}${row.unit_of_measure || "g"}` : "—"}</TableCell>
                          <TableCell className="text-[10px]">{row.product_type || "—"}</TableCell>
                          <TableCell className="text-[10px]">
                            {isSkipped ? (
                              <Badge variant="secondary" className="text-[9px]">skip</Badge>
                            ) : match ? (
                              <Badge variant="outline" className="text-[9px]">{match.matchType}</Badge>
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
            <Button onClick={commitImport} disabled={summary.newRows.length + summary.updateRows.length === 0}>
              Commit Import ({summary.newRows.length + summary.updateRows.length} products)
            </Button>
          </div>
        </div>
      )}

      {/* IMPORTING */}
      {stage === "importing" && (
        <Card>
          <CardContent className="py-12 space-y-4">
            <Progress value={progress} />
            <p className="text-sm text-muted-foreground text-center">Importing… {progress}%</p>
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
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <StatCard label="New" value={importResult.newCount} color="text-emerald-600 dark:text-emerald-400" />
              <StatCard label="Updated" value={importResult.updatedCount} color="text-primary" />
              <StatCard label="Skipped" value={importResult.skippedCount} color="text-muted-foreground" />
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
            <p className={`text-2xl font-bold mt-0.5 ${color}`}>{count}</p>
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
      <div className={`text-2xl font-bold ${color}`}>{value}</div>
      <div className="text-xs text-muted-foreground mt-1">{label}</div>
    </div>
  );
}
