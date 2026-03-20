import { useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MatchStatusBadge } from "./ImportStatusBadge";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "@/hooks/use-toast";
import { Link2, Plus, SkipForward, Search, Loader2 } from "lucide-react";

interface ImportRowData {
  id: string;
  row_number: number;
  source_name_raw: string | null;
  source_brand: string | null;
  source_sku: string | null;
  source_url: string | null;
  source_current_price: number | null;
  source_rrp: number | null;
  source_in_stock: boolean | null;
  source_category_path: string | null;
  source_image_url: string | null;
  match_status: string;
  match_method: string | null;
  match_confidence: number | null;
  matched_product_id: string | null;
  candidate_matches: Array<{ product_id: string; name: string; score: number; method: string }>;
  validation_errors: Array<{ field: string; message: string }>;
  resolution_action: string | null;
}

interface ImportRowReviewDrawerProps {
  row: ImportRowData | null;
  open: boolean;
  onClose: () => void;
  onResolved: () => void;
}

export function ImportRowReviewDrawer({ row, open, onClose, onResolved }: ImportRowReviewDrawerProps) {
  const [resolving, setResolving] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<Array<{ id: string; source_product_name: string | null; brand: string | null; sku: string | null }>>([]);
  const [searching, setSearching] = useState(false);

  if (!row) return null;

  const resolveRow = async (action: string, productId?: string) => {
    setResolving(true);
    try {
      const { error } = await supabase.functions.invoke("import-resolve", {
        body: {
          action: "resolve_row",
          row_id: row.id,
          resolution_action: action,
          matched_product_id: productId || row.matched_product_id,
        },
      });
      if (error) throw error;
      toast({ title: "Row resolved" });
      onResolved();
      onClose();
    } catch (err) {
      toast({ title: "Error resolving row", description: String(err), variant: "destructive" });
    } finally {
      setResolving(false);
    }
  };

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    setSearching(true);
    const { data } = await supabase
      .from("products")
      .select("id, source_product_name, brand, sku")
      .ilike("source_product_name", `%${searchQuery}%`)
      .limit(10);
    setSearchResults(data || []);
    setSearching(false);
  };

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-[500px] overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="text-base">Row #{row.row_number} Review</SheetTitle>
          <SheetDescription>Resolve this import row</SheetDescription>
        </SheetHeader>

        <div className="mt-4 space-y-4">
          {/* Source fields */}
          <div className="space-y-2">
            <h4 className="text-sm font-medium">Source Data</h4>
            <div className="grid gap-1 text-sm">
              <div><span className="text-muted-foreground">Name:</span> {row.source_name_raw || "—"}</div>
              <div><span className="text-muted-foreground">Brand:</span> {row.source_brand || "—"}</div>
              <div><span className="text-muted-foreground">SKU:</span> {row.source_sku || "—"}</div>
              <div><span className="text-muted-foreground">Price:</span> {row.source_current_price != null ? `$${row.source_current_price.toFixed(2)}` : "—"}</div>
              <div><span className="text-muted-foreground">RRP:</span> {row.source_rrp != null ? `$${row.source_rrp.toFixed(2)}` : "—"}</div>
              <div><span className="text-muted-foreground">In Stock:</span> {row.source_in_stock === null ? "—" : row.source_in_stock ? "Yes" : "No"}</div>
              <div><span className="text-muted-foreground">Category:</span> {row.source_category_path || "—"}</div>
              {row.source_url && (
                <div>
                  <span className="text-muted-foreground">URL:</span>{" "}
                  <a href={row.source_url} target="_blank" rel="noopener" className="text-primary underline text-xs break-all">
                    {row.source_url}
                  </a>
                </div>
              )}
            </div>
          </div>

          <Separator />

          {/* Match status */}
          <div className="space-y-2">
            <h4 className="text-sm font-medium">Match Status</h4>
            <div className="flex items-center gap-2">
              <MatchStatusBadge status={row.match_status} />
              {row.match_method && <span className="text-xs text-muted-foreground">via {row.match_method}</span>}
              {row.match_confidence != null && (
                <span className="text-xs text-muted-foreground">({(row.match_confidence * 100).toFixed(0)}%)</span>
              )}
            </div>
            {row.resolution_action && (
              <Badge variant="outline">Action: {row.resolution_action}</Badge>
            )}
          </div>

          {/* Validation errors */}
          {row.validation_errors.length > 0 && (
            <>
              <Separator />
              <div className="space-y-1">
                <h4 className="text-sm font-medium text-destructive">Validation Errors</h4>
                {row.validation_errors.map((e, i) => (
                  <div key={i} className="text-xs text-destructive">{e.field}: {e.message}</div>
                ))}
              </div>
            </>
          )}

          {/* Candidate matches */}
          {row.candidate_matches.length > 0 && (
            <>
              <Separator />
              <div className="space-y-2">
                <h4 className="text-sm font-medium">Candidate Matches</h4>
                {row.candidate_matches.map((c, i) => (
                  <div key={i} className="flex items-center justify-between rounded border p-2">
                    <div className="text-sm">
                      <div className="font-medium">{c.name || "Unnamed"}</div>
                      <div className="text-xs text-muted-foreground">{c.method} — {(c.score * 100).toFixed(0)}%</div>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={resolving}
                      onClick={() => resolveRow("manual_link", c.product_id)}
                    >
                      <Link2 className="mr-1 h-3 w-3" /> Link
                    </Button>
                  </div>
                ))}
              </div>
            </>
          )}

          <Separator />

          {/* Search for product */}
          <div className="space-y-2">
            <Label className="text-sm">Search Existing Products</Label>
            <div className="flex gap-2">
              <Input
                placeholder="Product name…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSearch()}
              />
              <Button size="sm" variant="outline" onClick={handleSearch} disabled={searching}>
                {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
              </Button>
            </div>
            {searchResults.map((p) => (
              <div key={p.id} className="flex items-center justify-between rounded border p-2">
                <div className="text-sm">
                  <div>{p.source_product_name || "Unnamed"}</div>
                  <div className="text-xs text-muted-foreground">{p.brand} {p.sku ? `· ${p.sku}` : ""}</div>
                </div>
                <Button size="sm" variant="outline" disabled={resolving} onClick={() => resolveRow("manual_link", p.id)}>
                  <Link2 className="mr-1 h-3 w-3" /> Link
                </Button>
              </div>
            ))}
          </div>

          <Separator />

          {/* Action buttons */}
          <div className="flex flex-col gap-2">
            <Button onClick={() => resolveRow("update")} disabled={resolving || !row.matched_product_id}>
              <Link2 className="mr-2 h-4 w-4" /> Link to Matched Product
            </Button>
            <Button variant="secondary" onClick={() => resolveRow("create")} disabled={resolving}>
              <Plus className="mr-2 h-4 w-4" /> Create New Product
            </Button>
            <Button variant="outline" onClick={() => resolveRow("skip")} disabled={resolving}>
              <SkipForward className="mr-2 h-4 w-4" /> Skip Row
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
