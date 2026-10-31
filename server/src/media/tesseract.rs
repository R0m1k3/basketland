//! Moteur OCR natif : libtesseract 5 (API C de `tesseract/capi.h`) et
//! Leptonica, compilé avec la fonction cargo `ocr` (l'image Docker l'active).
//!
//! Même usage que tesseract.js côté Node : moteur LSTM seul (`OEM 1`),
//! langue `eng` — le fichier `eng.traineddata` de `@tesseract.js-data/eng`
//! (`4.0.0_best_int`) est livré dans l'image, lu dans `TESSDATA_PREFIX` —,
//! image PNG décodée par Leptonica (`pixReadMem`, le `pixRead` de
//! tesseract.js), paramètres `tessedit_pageseg_mode`,
//! `tessedit_char_whitelist` et `debug_file=/dev/null` posés avant chaque
//! reconnaissance, mots lus mot à mot (texte, boîte, confiance).
//!
//! Une instance de Tesseract n'est pas réentrante : les reconnaissances
//! passent l'une après l'autre (verrou), sur un fil bloquant de Tokio.
//!
//! **`OMP_THREAD_LIMIT=1`** (posé par l'image Docker) : tesseract.js n'a
//! qu'un fil ; libtesseract, compilé avec OpenMP, en lance plusieurs, qui
//! s'attendent activement quand la machine est chargée. Mesuré ici : une
//! lecture psm 11 d'une bande de 1280×460 prend 68 s avec les fils par défaut,
//! 0,5 s avec un seul. La limite n'est lue par libgomp qu'au chargement du
//! processus (et Tesseract fixe le nombre de fils de ses boucles) : elle ne
//! peut pas être posée depuis le programme.

use crate::media::ocr::{OcrEngine, OcrFut, OcrPage, OcrParams, OcrWord};
use std::ffi::{c_char, c_float, c_int, c_void, CStr, CString};
use std::sync::{Arc, Mutex};

#[repr(C)]
struct TessBaseApi {
    _p: [u8; 0],
}
#[repr(C)]
struct TessResultIterator {
    _p: [u8; 0],
}
#[repr(C)]
struct TessPageIterator {
    _p: [u8; 0],
}
#[repr(C)]
struct Pix {
    _p: [u8; 0],
}

/// `OEM_LSTM_ONLY`.
const OEM_LSTM_ONLY: c_int = 1;
/// `RIL_WORD`.
const RIL_WORD: c_int = 3;

#[link(name = "tesseract")]
extern "C" {
    fn TessBaseAPICreate() -> *mut TessBaseApi;
    fn TessBaseAPIDelete(handle: *mut TessBaseApi);
    fn TessBaseAPIInit2(
        handle: *mut TessBaseApi,
        datapath: *const c_char,
        language: *const c_char,
        oem: c_int,
    ) -> c_int;
    fn TessBaseAPISetVariable(
        handle: *mut TessBaseApi,
        name: *const c_char,
        value: *const c_char,
    ) -> c_int;
    fn TessBaseAPISetImage2(handle: *mut TessBaseApi, pix: *mut Pix);
    fn TessBaseAPIRecognize(handle: *mut TessBaseApi, monitor: *mut c_void) -> c_int;
    fn TessBaseAPIGetUTF8Text(handle: *mut TessBaseApi) -> *mut c_char;
    fn TessBaseAPIGetIterator(handle: *mut TessBaseApi) -> *mut TessResultIterator;
    fn TessBaseAPIClear(handle: *mut TessBaseApi);
    fn TessBaseAPIEnd(handle: *mut TessBaseApi);
    fn TessDeleteText(text: *const c_char);
    fn TessResultIteratorDelete(handle: *mut TessResultIterator);
    fn TessResultIteratorGetPageIterator(handle: *mut TessResultIterator) -> *mut TessPageIterator;
    fn TessResultIteratorNext(handle: *mut TessResultIterator, level: c_int) -> c_int;
    fn TessResultIteratorGetUTF8Text(
        handle: *const TessResultIterator,
        level: c_int,
    ) -> *mut c_char;
    fn TessResultIteratorConfidence(handle: *const TessResultIterator, level: c_int) -> c_float;
    fn TessPageIteratorBoundingBox(
        handle: *const TessPageIterator,
        level: c_int,
        left: *mut c_int,
        top: *mut c_int,
        right: *mut c_int,
        bottom: *mut c_int,
    ) -> c_int;
    fn TessVersion() -> *const c_char;
}

#[link(name = "lept")]
extern "C" {
    fn pixReadMem(data: *const u8, size: usize) -> *mut Pix;
    fn pixDestroy(ppix: *mut *mut Pix);
}

struct Handle(*mut TessBaseApi);

// SAFETY: l'instance n'est utilisée que sous le verrou de `TesseractEngine`,
// par un seul fil à la fois ; Tesseract n'a pas d'affinité de fil.
unsafe impl Send for Handle {}

impl Drop for Handle {
    fn drop(&mut self) {
        // SAFETY: pointeur rendu par TessBaseAPICreate, libéré une seule fois.
        unsafe {
            TessBaseAPIEnd(self.0);
            TessBaseAPIDelete(self.0);
        }
    }
}

fn set_var(h: *mut TessBaseApi, name: &str, value: &str) -> Result<(), String> {
    let n = CString::new(name).map_err(|e| e.to_string())?;
    let v = CString::new(value).map_err(|e| e.to_string())?;
    // SAFETY: chaînes C valides pendant l'appel, instance initialisée.
    if unsafe { TessBaseAPISetVariable(h, n.as_ptr(), v.as_ptr()) } == 0 {
        return Err(format!("paramètre tesseract refusé : {name}"));
    }
    Ok(())
}

/// Texte C rendu par Tesseract → `String` (libéré).
fn take_text(p: *mut c_char) -> String {
    if p.is_null() {
        return String::new();
    }
    // SAFETY: chaîne UTF-8 terminée par NUL allouée par Tesseract, libérée ici.
    let s = unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned();
    unsafe { TessDeleteText(p) };
    s
}

/// Version de libtesseract (« 5.3.0 »).
pub fn tesseract_version() -> String {
    // SAFETY: chaîne statique de la bibliothèque.
    unsafe { CStr::from_ptr(TessVersion()) }
        .to_string_lossy()
        .into_owned()
}

/// Moteur Tesseract natif (voir la documentation du module).
#[derive(Clone)]
pub struct TesseractEngine(Arc<Mutex<Handle>>);

impl TesseractEngine {
    /// Démarre une instance (langue `eng`, LSTM seul) ; données de langue
    /// cherchées dans `TESSDATA_PREFIX` (sinon le dossier par défaut de libtesseract).
    pub fn new() -> Result<Self, String> {
        // SAFETY: création puis initialisation d'une instance neuve.
        let h = Handle(unsafe { TessBaseAPICreate() });
        if h.0.is_null() {
            return Err("OCR indisponible : Tesseract n'a pas démarré".into());
        }
        // Sans lui, une image vide fait écrire des histogrammes de débogage sur la sortie du serveur.
        set_var(h.0, "debug_file", "/dev/null")?;
        let lang = CString::new("eng").expect("eng");
        // SAFETY: instance valide, chemin des données NULL (TESSDATA_PREFIX).
        let rc = unsafe { TessBaseAPIInit2(h.0, std::ptr::null(), lang.as_ptr(), OEM_LSTM_ONLY) };
        if rc != 0 {
            return Err(format!(
                "OCR indisponible : données de langue « eng » de Tesseract introuvables (TESSDATA_PREFIX={})",
                std::env::var("TESSDATA_PREFIX").unwrap_or_default()
            ));
        }
        set_var(h.0, "tessedit_pageseg_mode", "11")?;
        set_var(h.0, "tessedit_char_whitelist", "")?;
        set_var(h.0, "debug_file", "/dev/null")?;
        Ok(TesseractEngine(Arc::new(Mutex::new(h))))
    }

    /// Reconnaissance synchrone (sous le verrou).
    pub fn recognize_blocking(&self, png: &[u8], params: &OcrParams) -> Result<OcrPage, String> {
        let guard = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let h = guard.0;
        set_var(h, "tessedit_pageseg_mode", params.psm())?;
        set_var(h, "tessedit_char_whitelist", params.whitelist())?;
        set_var(h, "debug_file", "/dev/null")?;
        // SAFETY: tampon valide pendant l'appel ; Leptonica copie l'image décodée.
        let mut pix = unsafe { pixReadMem(png.as_ptr(), png.len()) };
        if pix.is_null() {
            return Err("Error attempting to read image.".into());
        }
        // SAFETY: SetImage2 garde sa propre référence (pixClone) : la nôtre est libérée ensuite.
        unsafe {
            TessBaseAPISetImage2(h, pix);
            pixDestroy(&mut pix);
        }
        // SAFETY: image posée ; pas de moniteur.
        if unsafe { TessBaseAPIRecognize(h, std::ptr::null_mut()) } != 0 {
            unsafe { TessBaseAPIClear(h) };
            return Err("tesseract : reconnaissance impossible".into());
        }
        // SAFETY: résultats de la reconnaissance qui vient d'avoir lieu.
        let text = take_text(unsafe { TessBaseAPIGetUTF8Text(h) });
        let mut words = Vec::new();
        let it = unsafe { TessBaseAPIGetIterator(h) };
        if !it.is_null() {
            loop {
                // SAFETY: itérateur valide jusqu'à TessResultIteratorDelete.
                let w = unsafe { TessResultIteratorGetUTF8Text(it, RIL_WORD) };
                if !w.is_null() {
                    let conf = unsafe { TessResultIteratorConfidence(it, RIL_WORD) };
                    let (mut l, mut t, mut r, mut b) = (0, 0, 0, 0);
                    let page = unsafe { TessResultIteratorGetPageIterator(it) };
                    unsafe {
                        TessPageIteratorBoundingBox(page, RIL_WORD, &mut l, &mut t, &mut r, &mut b)
                    };
                    words.push(OcrWord {
                        text: take_text(w),
                        x0: l as f64,
                        y0: t as f64,
                        x1: r as f64,
                        y1: b as f64,
                        confidence: conf as f64,
                    });
                }
                if unsafe { TessResultIteratorNext(it, RIL_WORD) } == 0 {
                    break;
                }
            }
            unsafe { TessResultIteratorDelete(it) };
        }
        Ok(OcrPage { text, words })
    }
}

impl OcrEngine for TesseractEngine {
    fn recognize<'a>(&'a self, png: &'a [u8], params: &'a OcrParams) -> OcrFut<'a> {
        let me = self.clone();
        let (png, params) = (png.to_vec(), params.clone());
        Box::pin(async move {
            tokio::task::spawn_blocking(move || me.recognize_blocking(&png, &params))
                .await
                .map_err(|e| format!("tesseract : {e}"))?
        })
    }
}
