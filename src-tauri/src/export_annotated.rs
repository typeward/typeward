//! Annotated-PDF export: flatten open review threads into text-markup
//! (`/Highlight`) annotations placed in the compiled PDF, so a reader outside
//! Typeward sees the same highlighted span plus comment the editor paints.
//!
//! Geometry comes from one of three tiers, in order. The renderer resolves the
//! first two against the on-screen PDF and sends them as `quads` (top-origin
//! pt): the glyph-matched word rects, else the SyncTeX hbox. When it sends
//! none, SyncTeX forward runs here and maps (source file, line) → (page, hbox);
//! a hit with no box degrades to a `/Text` sticky note at the point, which is
//! all the geometry that exists for it.
//!
//! Every tier arrives top-origin, PDF's own space is bottom-left, so we flip
//! against the page MediaBox (`pdf_y = media_top - y`). Highlights carry an
//! appearance stream painting the quads with a Multiply blend, because viewers
//! that synthesize their own render the tint differently (or not at all when
//! printing). Output is written into `.typeward/build/annotated.pdf` — the
//! frontend copies it to the user's chosen destination via the dialog.

use lopdf::{Dictionary, Document, Object, ObjectId, Stream, StringFormat};
use serde::{Deserialize, Serialize};

use crate::project::{self, Project};

/// Upper bound on annotations processed per export — each spawns a synctex CLI
/// process, and the source review threads live in a project-local sidecar a
/// cloned repo could ship with an unbounded count.
const MAX_ANNOTATIONS: usize = 500;

/// Upper bound on the PDF handed to lopdf. `pdf_path` is renderer-supplied and a
/// malicious project can plant an oversized `.pdf` under the tree; lopdf parses
/// the whole file in memory, so cap it up front (mirrors the byte-bounded IPC
/// readers). Build PDFs are typically well under 100 MiB.
const MAX_PDF_BYTES: u64 = 512 * 1024 * 1024;

/// Upper bound on highlight rects honored per annotation. The renderer sends
/// one per typeset line the anchor text covers, so a real comment is in the
/// single digits; anything past this is a malformed payload, not a review.
const MAX_QUADS_PER_ANNOTATION: usize = 64;

/// Fallback highlight tint (0-1 RGB) when the caller sends no color: the
/// classic highlighter yellow, which reads on any page.
const DEFAULT_TINT: [f64; 3] = [1.0, 0.88, 0.36];

/// One highlight rect in top-origin, page-relative PDF points — the same space
/// the renderer paints its thread bands in.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuadInput {
    pub left: f64,
    pub top: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationInput {
    /// Source file relative to the project root.
    pub file: String,
    /// 1-based source line.
    pub line: u32,
    pub title: String,
    pub body: String,
    /// 1-based page, set when the renderer already resolved this thread against
    /// the on-screen PDF. Paired with `quads`; without both, SyncTeX runs here.
    #[serde(default)]
    pub page: Option<u32>,
    /// Highlight rects the renderer resolved, top-origin pt.
    #[serde(default)]
    pub quads: Vec<QuadInput>,
    /// Highlight tint as 0-1 RGB, pre-washed by the renderer to match the
    /// on-screen band under the Multiply blend.
    #[serde(default)]
    pub color: Option<[f64; 3]>,
}

impl AnnotationInput {
    /// Renderer-supplied geometry, or None when this thread still needs a
    /// SyncTeX lookup. Rejects non-finite and empty rects rather than emitting
    /// a degenerate quad a viewer would draw as a hairline or skip.
    fn renderer_placement(&self) -> Option<(u32, Vec<QuadInput>)> {
        let page = self.page.filter(|p| *p >= 1)?;
        let quads: Vec<QuadInput> = self
            .quads
            .iter()
            .copied()
            .filter(is_sane_quad)
            .take(MAX_QUADS_PER_ANNOTATION)
            .collect();
        (!quads.is_empty()).then_some((page, quads))
    }

    fn tint(&self) -> [f64; 3] {
        match self.color {
            Some(c) if c.iter().all(|v| v.is_finite()) => c.map(|v| v.clamp(0.0, 1.0)),
            _ => DEFAULT_TINT,
        }
    }
}

fn is_sane_quad(q: &QuadInput) -> bool {
    [q.left, q.top, q.width, q.height]
        .iter()
        .all(|v| v.is_finite())
        && q.width > 0.0
        && q.height > 0.0
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedAnnotation {
    pub file: String,
    pub line: u32,
    pub reason: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnotatedExportResult {
    pub path: String,
    pub annotated: u32,
    pub skipped: Vec<SkippedAnnotation>,
}

#[tauri::command]
pub async fn export_pdf_annotated(
    project: Project,
    pdf_path: String,
    annotations: Vec<AnnotationInput>,
) -> Result<AnnotatedExportResult, String> {
    // Off the event-loop thread: each annotation shells out to the synctex CLI
    // (which gunzips a potentially multi-MB `.synctex.gz`) and lopdf parses the
    // whole PDF.
    tokio::task::spawn_blocking(move || run(project, &pdf_path, annotations))
        .await
        .map_err(|e| e.to_string())?
}

fn run(
    project: Project,
    pdf_path: &str,
    annotations: Vec<AnnotationInput>,
) -> Result<AnnotatedExportResult, String> {
    let (root, _root_file) = crate::commands::checked_project_root_and_file(&project)?;

    let Some(pdf) = crate::synctex::resolve_pdf_under_root(&root, pdf_path)? else {
        return Err("compiled PDF not found; build the project first".into());
    };

    // Bound the PDF parse UP FRONT — before any synctex work — so an oversized
    // planted .pdf is rejected without first spawning up to 500 synctex
    // processes. lopdf reads the whole file into memory.
    let pdf_size = std::fs::metadata(&pdf).map_err(|e| e.to_string())?.len();
    if pdf_size > MAX_PDF_BYTES {
        return Err(format!(
            "PDF is too large to annotate ({} MiB; limit {} MiB)",
            pdf_size / (1024 * 1024),
            MAX_PDF_BYTES / (1024 * 1024)
        ));
    }

    // Resolve synctex ONCE, not per annotation (a review-heavy export otherwise
    // PATH-scans up to 500x), and only for the threads that still need it: a
    // renderer that already resolved every highlight must not be blocked on a
    // CLI this export never calls. When some thread does need it, an absent
    // synctex would skip all of them for the same reason, so surface that as
    // one actionable error instead of a partly-placed result.
    let needs_synctex = annotations
        .iter()
        .take(MAX_ANNOTATIONS)
        .any(|a| a.renderer_placement().is_none());
    let synctex = if needs_synctex {
        Some(crate::detect::resolve_program("synctex").map_err(|_| {
            "SyncTeX is unavailable; annotation placement needs a LaTeX build with SyncTeX"
                .to_string()
        })?)
    } else {
        None
    };

    let mut skipped: Vec<SkippedAnnotation> = Vec::new();
    let mut placements: Vec<(usize, u32, Placement)> = Vec::new();

    for (idx, ann) in annotations.iter().enumerate() {
        // Bound the per-annotation synctex spawns: review threads come from a
        // project-local sidecar a cloned repo could ship with thousands of
        // entries (mirrors todo_scan's caps). Excess is reported, not silent.
        if idx >= MAX_ANNOTATIONS {
            skipped.push(skip(ann, "annotation limit reached (max 500)"));
            continue;
        }
        if let Some((page, quads)) = ann.renderer_placement() {
            placements.push((idx, page, Placement::Quads(quads)));
            continue;
        }
        let source = match project::resolve_existing_project_path(&root, &ann.file) {
            Ok(p) => p,
            Err(_) => {
                skipped.push(skip(ann, "source file not found"));
                continue;
            }
        };
        let loc = match &synctex {
            Some(sx) => crate::synctex::forward_with(sx, &pdf, &source, ann.line)?,
            None => None,
        };
        match loc {
            // synctex reports the enclosing hbox as (h, v): its left edge and
            // BOTTOM in top-origin pt, width 0 meaning it reported no box. Same
            // derivation the renderer applies to its own forward lookups.
            Some(loc) if loc.width > 0.0 && loc.height > 0.0 => placements.push((
                idx,
                loc.page,
                Placement::Quads(vec![QuadInput {
                    left: loc.h,
                    top: loc.v - loc.height,
                    width: loc.width,
                    height: loc.height,
                }]),
            )),
            Some(loc) => placements.push((idx, loc.page, Placement::Point(loc.x, loc.y))),
            None => skipped.push(skip(ann, "no SyncTeX mapping")),
        }
    }

    let mut doc = Document::load(&pdf).map_err(|e| format!("failed to read PDF: {e}"))?;
    let pages = doc.get_pages();
    let mut annotated: u32 = 0;

    for (idx, page_no, placement) in placements {
        let ann = &annotations[idx];
        let Some(&page_id) = pages.get(&page_no) else {
            skipped.push(skip(ann, "page out of range"));
            continue;
        };
        let Some((x0, y_top)) = media_box_origin_top(&doc, page_id) else {
            skipped.push(skip(ann, "page has no MediaBox"));
            continue;
        };
        // Every tier arrives top-origin; PDF is bottom-left. Honor a non-zero
        // MediaBox origin (cropped/imposed PDFs) rather than assuming (0,0):
        // flip against the top edge and offset x by the left edge.
        match placement {
            Placement::Quads(quads) => {
                let rects: Vec<[f64; 4]> = quads.iter().map(|q| flip_quad(x0, y_top, q)).collect();
                append_highlight_annotation(
                    &mut doc,
                    page_id,
                    &rects,
                    &ann.title,
                    &ann.body,
                    ann.tint(),
                );
            }
            Placement::Point(x, y) => {
                append_text_annotation(&mut doc, page_id, x0 + x, y_top - y, &ann.title, &ann.body);
            }
        }
        annotated += 1;
    }

    let out_dir = root.join(".typeward").join("build");
    std::fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;
    let out = out_dir.join("annotated.pdf");
    doc.save(&out)
        .map_err(|e| format!("failed to write annotated PDF: {e}"))?;

    Ok(AnnotatedExportResult {
        path: out.to_string_lossy().into_owned(),
        annotated,
        skipped,
    })
}

/// Resolved geometry for one annotation, top-origin page-relative pt.
/// `Quads` becomes a `/Highlight` over the span the comment is anchored to;
/// `Point` is the last resort, a sticky note where SyncTeX gave a position but
/// no box to underlay.
enum Placement {
    Quads(Vec<QuadInput>),
    Point(f64, f64),
}

fn skip(ann: &AnnotationInput, reason: &str) -> SkippedAnnotation {
    SkippedAnnotation {
        file: ann.file.clone(),
        line: ann.line,
        reason: reason.to_string(),
    }
}

/// MediaBox left edge (x0) and top edge (max y) for a page, walking up the
/// `Parent` chain since MediaBox is an inheritable page attribute (bounded to
/// avoid a malicious cyclic tree). The top edge is used for the top-left→
/// bottom-left synctex y flip; x0 offsets a non-zero-origin page.
fn media_box_origin_top(doc: &Document, page_id: ObjectId) -> Option<(f64, f64)> {
    let mut current = page_id;
    for _ in 0..32 {
        let dict = doc.get_dictionary(current).ok()?;
        if let Ok(mb) = dict.get(b"MediaBox") {
            let arr = resolve_array(doc, mb)?;
            if arr.len() == 4 {
                let x0 = number(&arr[0])?;
                let y0 = number(&arr[1])?;
                let y1 = number(&arr[3])?;
                // Normalize a reversed box; the top edge is the larger y.
                return Some((x0, y0.max(y1)));
            }
        }
        match dict.get(b"Parent") {
            Ok(Object::Reference(pid)) => current = *pid,
            _ => break,
        }
    }
    None
}

/// Append a closed sticky-note (`/Text`) annotation anchored at `(x, pdf_y)`,
/// both in PDF points with a bottom-left origin.
fn append_text_annotation(
    doc: &mut Document,
    page_id: ObjectId,
    x: f64,
    pdf_y: f64,
    title: &str,
    body: &str,
) {
    let mut annot = Dictionary::new();
    annot.set("Type", "Annot");
    annot.set("Subtype", "Text");
    annot.set(
        "Rect",
        vec![real(x), real(pdf_y - 18.0), real(x + 18.0), real(pdf_y)],
    );
    annot.set("Contents", text_string(body));
    annot.set("T", text_string(title));
    annot.set("Name", "Comment");
    annot.set("Open", false);

    let annot_id = doc.add_object(annot);
    push_annot(doc, page_id, annot_id);
}

/// Append a text-markup (`/Highlight`) annotation covering `rects` (each
/// `[x0, y0, x1, y1]` in bottom-left-origin PDF points), carrying the comment
/// as its `/Contents` so a viewer shows the note against the highlighted span.
///
/// The appearance stream is written explicitly rather than left to the viewer:
/// a synthesized one varies from viewer to viewer, and several drop the tint
/// entirely when printing. `tint` is 0-1 RGB, pre-washed by the caller for the
/// Multiply blend.
fn append_highlight_annotation(
    doc: &mut Document,
    page_id: ObjectId,
    rects: &[[f64; 4]],
    title: &str,
    body: &str,
    tint: [f64; 3],
) {
    if rects.is_empty() {
        return;
    }
    let bbox = union_rect(rects);
    // The annotation and its popup reference each other, so reserve the id
    // before the popup that has to name it as /Parent.
    let annot_id = doc.new_object_id();
    let ap_id = highlight_appearance(doc, bbox, rects, tint);

    let mut popup = Dictionary::new();
    popup.set("Type", "Annot");
    popup.set("Subtype", "Popup");
    popup.set(
        "Rect",
        vec![
            real(bbox[2]),
            real(bbox[1] - 96.0),
            real(bbox[2] + 180.0),
            real(bbox[1]),
        ],
    );
    popup.set("Parent", Object::Reference(annot_id));
    popup.set("Open", false);
    let popup_id = doc.add_object(popup);

    // QuadPoints corners in Acrobat's de-facto order (upper-left, upper-right,
    // lower-left, lower-right); the spec's stated winding is not what viewers
    // actually read.
    let mut quad_points: Vec<Object> = Vec::with_capacity(rects.len() * 8);
    for r in rects {
        for v in [r[0], r[3], r[2], r[3], r[0], r[1], r[2], r[1]] {
            quad_points.push(real(v));
        }
    }

    let mut annot = Dictionary::new();
    annot.set("Type", "Annot");
    annot.set("Subtype", "Highlight");
    annot.set(
        "Rect",
        vec![real(bbox[0]), real(bbox[1]), real(bbox[2]), real(bbox[3])],
    );
    annot.set("QuadPoints", quad_points);
    annot.set("Contents", text_string(body));
    annot.set("T", text_string(title));
    annot.set("C", vec![real(tint[0]), real(tint[1]), real(tint[2])]);
    annot.set("CA", Object::Real(1.0));
    // Print, so the highlight survives a paper review pass.
    annot.set("F", Object::Integer(4));
    let now = pdf_date_now();
    annot.set("M", text_string(&now));
    annot.set("CreationDate", text_string(&now));
    annot.set("Popup", Object::Reference(popup_id));
    annot.set("AP", {
        let mut ap = Dictionary::new();
        ap.set("N", Object::Reference(ap_id));
        ap
    });
    doc.objects.insert(annot_id, Object::Dictionary(annot));

    push_annot(doc, page_id, annot_id);
    push_annot(doc, page_id, popup_id);
}

/// Form XObject painting `rects` in `tint` under a Multiply blend, which is how
/// a highlighter reads over black text. Form space is page space (no /Matrix),
/// so the BBox is the annotation Rect.
fn highlight_appearance(
    doc: &mut Document,
    bbox: [f64; 4],
    rects: &[[f64; 4]],
    tint: [f64; 3],
) -> ObjectId {
    let mut ops = format!("/GSm gs {:.4} {:.4} {:.4} rg\n", tint[0], tint[1], tint[2]);
    for r in rects {
        ops.push_str(&format!(
            "{:.3} {:.3} {:.3} {:.3} re\n",
            r[0],
            r[1],
            r[2] - r[0],
            r[3] - r[1]
        ));
    }
    ops.push_str("f\n");

    let mut gs = Dictionary::new();
    gs.set("Type", "ExtGState");
    gs.set("BM", "Multiply");
    gs.set("ca", Object::Real(1.0));
    let mut ext = Dictionary::new();
    ext.set("GSm", gs);
    let mut resources = Dictionary::new();
    resources.set("ExtGState", ext);

    let mut group = Dictionary::new();
    group.set("S", "Transparency");
    group.set("CS", "DeviceRGB");

    let mut dict = Dictionary::new();
    dict.set("Type", "XObject");
    dict.set("Subtype", "Form");
    dict.set("FormType", Object::Integer(1));
    dict.set(
        "BBox",
        vec![real(bbox[0]), real(bbox[1]), real(bbox[2]), real(bbox[3])],
    );
    dict.set("Resources", resources);
    dict.set("Group", group);

    doc.add_object(Stream::new(dict, ops.into_bytes()))
}

/// Top-origin, page-relative quad to a bottom-left-origin PDF rect
/// `[x0, y0, x1, y1]`, offset by the page's MediaBox left edge.
fn flip_quad(x_left: f64, y_top: f64, q: &QuadInput) -> [f64; 4] {
    [
        x_left + q.left,
        y_top - (q.top + q.height),
        x_left + q.left + q.width,
        y_top - q.top,
    ]
}

fn union_rect(rects: &[[f64; 4]]) -> [f64; 4] {
    let mut out = rects[0];
    for r in &rects[1..] {
        out[0] = out[0].min(r[0]);
        out[1] = out[1].min(r[1]);
        out[2] = out[2].max(r[2]);
        out[3] = out[3].max(r[3]);
    }
    out
}

/// PDF date string (`D:YYYYMMDDHHmmSSOHH'mm'`). Acrobat's comment list shows a
/// blank timestamp without one.
fn pdf_date_now() -> String {
    let now = chrono::Local::now();
    let offset = now.offset().local_minus_utc();
    let sign = if offset < 0 { '-' } else { '+' };
    let offset = offset.abs();
    format!(
        "{}{}{:02}'{:02}'",
        now.format("D:%Y%m%d%H%M%S"),
        sign,
        offset / 3600,
        (offset % 3600) / 60
    )
}

/// Append an annotation object to a page's `/Annots`, handling all three
/// shapes: an indirect array, an inline array, or no array yet.
fn push_annot(doc: &mut Document, page_id: ObjectId, annot_id: ObjectId) {
    let existing = doc
        .get_dictionary(page_id)
        .ok()
        .and_then(|d| d.get(b"Annots").ok().cloned());
    match existing {
        Some(Object::Reference(arr_id)) => {
            if let Ok(Object::Array(arr)) = doc.get_object_mut(arr_id) {
                arr.push(Object::Reference(annot_id));
            }
        }
        Some(Object::Array(mut arr)) => {
            arr.push(Object::Reference(annot_id));
            if let Ok(page) = doc.get_dictionary_mut(page_id) {
                page.set("Annots", Object::Array(arr));
            }
        }
        _ => {
            if let Ok(page) = doc.get_dictionary_mut(page_id) {
                page.set("Annots", Object::Array(vec![Object::Reference(annot_id)]));
            }
        }
    }
}

fn real(v: f64) -> Object {
    Object::Real(v as f32)
}

/// A PDF text string: plain-ASCII literal when it fits, else UTF-16BE with a
/// BOM so non-ASCII review text (accents, CJK) renders correctly in viewers.
fn text_string(s: &str) -> Object {
    if s.is_ascii() {
        Object::String(s.as_bytes().to_vec(), StringFormat::Literal)
    } else {
        let mut bytes = vec![0xFE, 0xFF];
        for u in s.encode_utf16() {
            bytes.extend_from_slice(&u.to_be_bytes());
        }
        Object::String(bytes, StringFormat::Literal)
    }
}

fn resolve_array(doc: &Document, obj: &Object) -> Option<Vec<Object>> {
    match obj {
        Object::Array(a) => Some(a.clone()),
        Object::Reference(id) => match doc.get_object(*id).ok()? {
            Object::Array(a) => Some(a.clone()),
            _ => None,
        },
        _ => None,
    }
}

fn number(obj: &Object) -> Option<f64> {
    match obj {
        Object::Integer(i) => Some(*i as f64),
        Object::Real(r) => Some(*r as f64),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::dictionary;

    fn one_page_doc() -> (Document, ObjectId) {
        let mut doc = Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let page_id = doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
        });
        let pages = dictionary! {
            "Type" => "Pages",
            "Kids" => vec![page_id.into()],
            "Count" => 1,
        };
        doc.objects.insert(pages_id, Object::Dictionary(pages));
        let catalog_id = doc.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        doc.trailer.set("Root", catalog_id);
        (doc, page_id)
    }

    #[test]
    fn appends_annots_array_with_text_annotation() {
        let (mut doc, page_id) = one_page_doc();
        append_text_annotation(&mut doc, page_id, 72.0, 700.0, "Reviewer", "Fix this");

        let annots = doc
            .get_dictionary(page_id)
            .unwrap()
            .get(b"Annots")
            .unwrap()
            .as_array()
            .unwrap();
        assert_eq!(annots.len(), 1);

        let annot_id = annots[0].as_reference().unwrap();
        let annot = doc.get_dictionary(annot_id).unwrap();
        assert_eq!(annot.get(b"Subtype").unwrap().as_name().unwrap(), b"Text");
        assert_eq!(annot.get(b"Name").unwrap().as_name().unwrap(), b"Comment");
        // Rect is [x, pdf_y-18, x+18, pdf_y].
        let rect = annot.get(b"Rect").unwrap().as_array().unwrap();
        assert_eq!(rect.len(), 4);
    }

    #[test]
    fn appends_to_existing_annots_array() {
        let (mut doc, page_id) = one_page_doc();
        append_text_annotation(&mut doc, page_id, 10.0, 100.0, "A", "one");
        append_text_annotation(&mut doc, page_id, 20.0, 200.0, "B", "two");
        let annots = doc
            .get_dictionary(page_id)
            .unwrap()
            .get(b"Annots")
            .unwrap()
            .as_array()
            .unwrap();
        assert_eq!(annots.len(), 2);
    }

    #[test]
    fn reads_inherited_media_box_origin_top() {
        let (doc, page_id) = one_page_doc();
        assert_eq!(media_box_origin_top(&doc, page_id), Some((0.0, 792.0)));
    }

    fn quad(left: f64, top: f64, width: f64, height: f64) -> QuadInput {
        QuadInput {
            left,
            top,
            width,
            height,
        }
    }

    fn ann_with(page: Option<u32>, quads: Vec<QuadInput>) -> AnnotationInput {
        AnnotationInput {
            file: "main.tex".into(),
            line: 1,
            title: "Reviewer".into(),
            body: "Fix this".into(),
            page,
            quads,
            color: None,
        }
    }

    #[test]
    fn appends_highlight_with_quadpoints_popup_and_appearance() {
        let (mut doc, page_id) = one_page_doc();
        append_highlight_annotation(
            &mut doc,
            page_id,
            &[[72.0, 700.0, 200.0, 712.0], [72.0, 686.0, 150.0, 698.0]],
            "Reviewer",
            "Fix this",
            [1.0, 0.9, 0.4],
        );

        let annots = doc
            .get_dictionary(page_id)
            .unwrap()
            .get(b"Annots")
            .unwrap()
            .as_array()
            .unwrap()
            .clone();
        // The markup annotation plus its popup.
        assert_eq!(annots.len(), 2);

        let annot = doc
            .get_dictionary(annots[0].as_reference().unwrap())
            .unwrap();
        assert_eq!(
            annot.get(b"Subtype").unwrap().as_name().unwrap(),
            b"Highlight"
        );
        // Eight numbers per rect, four corners each.
        assert_eq!(
            annot.get(b"QuadPoints").unwrap().as_array().unwrap().len(),
            16
        );
        // Rect is the union of both rects.
        let rect: Vec<f64> = annot
            .get(b"Rect")
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .map(|o| number(o).unwrap())
            .collect();
        assert_eq!(rect, vec![72.0, 686.0, 200.0, 712.0]);
        assert!(annot.get(b"Contents").is_ok());
        // Printable, so a paper review keeps the highlight.
        assert_eq!(annot.get(b"F").unwrap().as_i64().unwrap(), 4);

        let popup_id = annot.get(b"Popup").unwrap().as_reference().unwrap();
        let popup = doc.get_dictionary(popup_id).unwrap();
        assert_eq!(popup.get(b"Subtype").unwrap().as_name().unwrap(), b"Popup");
        assert_eq!(
            popup.get(b"Parent").unwrap().as_reference().unwrap(),
            annots[0].as_reference().unwrap()
        );

        // The appearance stream paints under a Multiply blend, one `re` per rect.
        let ap_id = annot
            .get(b"AP")
            .unwrap()
            .as_dict()
            .unwrap()
            .get(b"N")
            .unwrap()
            .as_reference()
            .unwrap();
        let stream = doc.get_object(ap_id).unwrap().as_stream().unwrap();
        let ops = String::from_utf8_lossy(&stream.content);
        assert_eq!(ops.matches(" re").count(), 2);
        let blend = stream
            .dict
            .get(b"Resources")
            .unwrap()
            .as_dict()
            .unwrap()
            .get(b"ExtGState")
            .unwrap()
            .as_dict()
            .unwrap()
            .get(b"GSm")
            .unwrap()
            .as_dict()
            .unwrap()
            .get(b"BM")
            .unwrap()
            .as_name()
            .unwrap()
            .to_vec();
        assert_eq!(blend, b"Multiply".to_vec());
    }

    #[test]
    fn flips_top_origin_quad_against_the_media_box() {
        // A 12pt-tall rect 30pt down a 792pt page, on a page whose left edge is 20.
        let r = flip_quad(20.0, 792.0, &quad(72.0, 30.0, 100.0, 12.0));
        assert_eq!(r, [92.0, 750.0, 192.0, 762.0]);
    }

    #[test]
    fn renderer_placement_needs_a_page_and_a_usable_quad() {
        assert!(
            ann_with(None, vec![quad(1.0, 1.0, 10.0, 10.0)])
                .renderer_placement()
                .is_none()
        );
        assert!(
            ann_with(Some(0), vec![quad(1.0, 1.0, 10.0, 10.0)])
                .renderer_placement()
                .is_none()
        );
        assert!(ann_with(Some(1), vec![]).renderer_placement().is_none());
        // Degenerate and non-finite rects are dropped, not emitted as hairlines.
        assert!(
            ann_with(Some(1), vec![quad(1.0, 1.0, 0.0, 10.0)])
                .renderer_placement()
                .is_none()
        );
        assert!(
            ann_with(Some(1), vec![quad(f64::NAN, 1.0, 10.0, 10.0)])
                .renderer_placement()
                .is_none()
        );
        let ok = ann_with(Some(3), vec![quad(1.0, 1.0, 10.0, 10.0)])
            .renderer_placement()
            .unwrap();
        assert_eq!(ok.0, 3);
        assert_eq!(ok.1.len(), 1);
    }

    #[test]
    fn renderer_placement_caps_the_quad_count() {
        let quads = vec![quad(1.0, 1.0, 10.0, 10.0); MAX_QUADS_PER_ANNOTATION + 20];
        let (_, kept) = ann_with(Some(1), quads).renderer_placement().unwrap();
        assert_eq!(kept.len(), MAX_QUADS_PER_ANNOTATION);
    }

    #[test]
    fn tint_clamps_and_falls_back() {
        let mut a = ann_with(Some(1), vec![]);
        assert_eq!(a.tint(), DEFAULT_TINT);
        a.color = Some([f64::NAN, 0.5, 0.5]);
        assert_eq!(a.tint(), DEFAULT_TINT);
        a.color = Some([-1.0, 0.5, 2.0]);
        assert_eq!(a.tint(), [0.0, 0.5, 1.0]);
    }

    #[test]
    fn encodes_non_ascii_body_as_utf16be_bom() {
        match text_string("café") {
            Object::String(bytes, StringFormat::Literal) => {
                assert_eq!(&bytes[0..2], &[0xFE, 0xFF]);
            }
            _ => panic!("expected a literal string"),
        }
    }
}
