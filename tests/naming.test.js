// Tests for content-based auto-naming on upload:
// PDF /Title (literal + hex), image EXIF shoot date, text first-line,
// and graceful fallback (original name) for opaque types like zip.
import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { PHOTO_EXIF_B64, PHOTO_PLAIN_B64, b64ToBytes } from "./fixtures.js";

const fetch = (...args) => SELF.fetch(...args);

async function resetDb() {
  await env.DB.prepare("DELETE FROM docs").run();
  await env.DB.prepare("DELETE FROM actions").run();
}

async function upload(file, fields = {}) {
  const fd = new FormData();
  fd.append("file", file, file.name);
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  const r = await fetch("https://example.com/api/upload", { method: "POST", body: fd });
  const j = await r.json();
  return { r, j };
}

function todayStamp() {
  const d = new Date();
  return (
    String(d.getDate()).padStart(2, "0") +
    String(d.getMonth() + 1).padStart(2, "0") +
    d.getFullYear()
  );
}

const PDF_TITLED = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
trailer
<< /Root 1 0 R /Info << /Title (Quarterly Report Q3) /Author (filo) >> >>
%%EOF`;

const PDF_HEX_TITLE = `%PDF-1.4
trailer
<< /Info << /Title <FEFF00480065006C006C006F> >> >>
%%EOF`;

// "Hello" in UTF-16BE with BOM

const PDF_NO_TITLE = `%PDF-1.4
1 0 obj
<< /Type /Catalog >>
endobj
trailer
<< /Root 1 0 R >>
%%EOF`;

beforeEach(resetDb);

describe("content-based naming", () => {
  it("names a PDF from its /Title (literal string)", async () => {
    const { r, j } = await upload(new File([PDF_TITLED], "scan.pdf", { type: "application/pdf" }));
    expect(r.status).toBe(200);
    // "Quarterly Report Q3" -> squish -> "QuarterlyR" (10) + date
    expect(j.filename).toMatch(/^QuarterlyR\d{8}\.pdf$/);
    // no typed title → title column stays NULL (dashboard shows filename)
    const row = await env.DB.prepare("SELECT title FROM docs WHERE id = ?").bind(j.id).first();
    expect(row.title).toBeNull();
  });

  it("names a PDF from a hex-encoded /Title", async () => {
    const { r, j } = await upload(new File([PDF_HEX_TITLE], "doc.pdf", { type: "application/pdf" }));
    expect(r.status).toBe(200);
    expect(j.filename).toMatch(/^Hello\d{8}\.pdf$/);
  });

  it("falls back to the original name when a PDF has no title", async () => {
    const { r, j } = await upload(new File([PDF_NO_TITLE], "scan.pdf", { type: "application/pdf" }));
    expect(r.status).toBe(200);
    expect(j.filename).toMatch(/^scan\d{8}\.pdf$/);
  });

  it("typed title beats embedded PDF title", async () => {
    const { r, j } = await upload(new File([PDF_TITLED], "scan.pdf", { type: "application/pdf" }), {
      title: "Custom",
    });
    expect(r.status).toBe(200);
    expect(j.filename).toMatch(/^Custom\d{8}\.pdf$/);
  });

  it("dates a photo by EXIF shoot date, not upload date", async () => {
    const bytes = b64ToBytes(PHOTO_EXIF_B64);
    const { r, j } = await upload(
      new File([bytes], "IMG_1234.jpg", { type: "image/jpeg" })
    );
    expect(r.status).toBe(200);
    // fixture DateTimeOriginal = 2021-05-04 → 04052021, not today
    expect(j.filename).toMatch(/^IMG_123404052021\.jpg$/);
  });

  it("falls back to the upload date when a photo has no EXIF", async () => {
    const bytes = b64ToBytes(PHOTO_PLAIN_B64);
    const { r, j } = await upload(
      new File([bytes], "shot.jpg", { type: "image/jpeg" })
    );
    expect(r.status).toBe(200);
    expect(j.filename).toMatch(new RegExp(`^shot${todayStamp()}\\.jpg$`));
  });

  it("keeps original-name fallback for opaque types (zip)", async () => {
    const { r, j } = await upload(
      new File(["PK\x03\x04binary-blob"], "backup 2024.zip", { type: "application/zip" })
    );
    expect(r.status).toBe(200);
    expect(j.filename).toMatch(new RegExp(`^backup2024${todayStamp()}\\.zip$`));
  });

  it("puts the filename in the URL so tabs show the name, not the id", async () => {
    const { r, j } = await upload(new File([PDF_TITLED], "scan.pdf", { type: "application/pdf" }));
    expect(r.status).toBe(200);
    expect(j.url).toMatch(new RegExp(`/p/${j.id}/` + encodeURIComponent(j.filename) + "$"));
    // slugged URL serves the exact bytes…
    const slugged = await fetch(`https://example.com/p/${j.id}/` + encodeURIComponent(j.filename));
    expect(slugged.status).toBe(200);
    expect(await slugged.text()).toBe(PDF_TITLED);
    // …and the bare legacy URL keeps working
    const bare = await fetch(`https://example.com/p/${j.id}`);
    expect(bare.status).toBe(200);
  });

  it("sniffs the first line for text with a generic filename", async () => {
    // browser default filename ("blob") is unusable → first-line sniffing
    const fd = new FormData();
    fd.append("file", new Blob(["Shopping List\n- milk\n- eggs"], { type: "text/plain" }));
    const r = await fetch("https://example.com/api/upload", { method: "POST", body: fd });
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.filename).toMatch(new RegExp(`^ShoppingLi${todayStamp()}\\.bin$`));
  });
});
