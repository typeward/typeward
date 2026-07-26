//! Annotated-PDF export: flatten open review threads into sticky-note (`/Text`)
//! annotations placed in the compiled PDF via SyncTeX.
//!
//! Placement pipeline per annotation: SyncTeX forward maps (source file, line)
//! → (page, x, y) in PDF points with a *top-left* origin; PDF's own coordinate
//! space is *bottom-left*, so we flip against the page MediaBox height
//! (`pdf_y = media_height - y`). The annotation object is appended to the target
//! page's `/Annots` array. Output is written into `.typeward/build/annotated.pdf`
//! — the frontend copies it to the user's chosen destination via the dialog.

use lopdf::{Dictionary, Document, Object, ObjectId, StringFormat};
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationInput {
    /// Source file relative to the project root.
    pub file: String,
    /// 1-based source line.
    pub line: u32,
    pub title: String,
    pub body: String,
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
        return Err("compiled PDF not found — build the project first".into());
    };

    // Resolve synctex ONCE, not per annotation (a review-heavy export otherwise
    // PATH-scans up to 500×). If it isn't installed every annotation would skip
    // for the same reason, so surface that as one actionable error instead of an
    // all-skipped no-op result.
    let synctex = if annotations.is_empty() {
        None
    } else {
        Some(crate::detect::resolve_program("synctex").map_err(|_| {
            "SyncTeX is unavailable — annotation placement needs a LaTeX build with SyncTeX"
                .to_string()
        })?)
    };

    let mut skipped: Vec<SkippedAnnotation> = Vec::new();
    // (index into annotations, page, synctex x, synctex y).
    let mut placements: Vec<(usize, u32, f64, f64)> = Vec::new();

    for (idx, ann) in annotations.iter().enumerate() {
        // Bound the per-annotation synctex spawns — review threads come from a
        // project-local sidecar a cloned repo could ship with thousands of
        // entries (mirrors todo_scan's caps). Excess is reported, not silent.
        if idx >= MAX_ANNOTATIONS {
            skipped.push(skip(ann, "annotation limit reached (max 500)"));
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
            Some(loc) => placements.push((idx, loc.page, loc.x, loc.y)),
            None => skipped.push(skip(ann, "no SyncTeX mapping")),
        }
    }

    // Bound the PDF parse before lopdf reads the whole file into memory.
    let pdf_size = std::fs::metadata(&pdf).map_err(|e| e.to_string())?.len();
    if pdf_size > MAX_PDF_BYTES {
        return Err(format!(
            "PDF is too large to annotate ({} MiB; limit {} MiB)",
            pdf_size / (1024 * 1024),
            MAX_PDF_BYTES / (1024 * 1024)
        ));
    }
    let mut doc = Document::load(&pdf).map_err(|e| format!("failed to read PDF: {e}"))?;
    let pages = doc.get_pages();
    let mut annotated: u32 = 0;

    for (idx, page_no, x, y) in placements {
        let ann = &annotations[idx];
        let Some(&page_id) = pages.get(&page_no) else {
            skipped.push(skip(ann, "page out of range"));
            continue;
        };
        let Some((x0, y_top)) = media_box_origin_top(&doc, page_id) else {
            skipped.push(skip(ann, "page has no MediaBox"));
            continue;
        };
        // synctex origin is the page's top-left; PDF origin is bottom-left. Honor
        // a non-zero MediaBox origin (cropped/imposed PDFs) rather than assuming
        // (0,0): flip against the top edge and offset x by the left edge.
        let pdf_y = y_top - y;
        append_text_annotation(&mut doc, page_id, x0 + x, pdf_y, &ann.title, &ann.body);
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

    // Append to the page's /Annots, handling all three shapes: an indirect
    // array, an inline array, or no array yet.
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
