//! Montage d'un tronçon doublé (`assembleChunk` de `dub.ts`) : `duration`
//! secondes de silence, chaque réplique posée à sa place (accélérée si
//! besoin), en AAC mono 24 kHz ~48 kb/s dans un MP4 audio (.m4a).

use super::text::{to_fixed, DUB_SAMPLE_RATE};
use crate::js::{self, jsre};
use crate::jsval::js_number_string;
use crate::media::abort::{wait_aborted, AbortSignal};
use crate::media::audio::ffmpeg_bin;
use crate::media::proc::{exit_code_text, keep_tail, lower_priority, spawn_error_text};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::process::Command;

/// Réplique à monter (`AssembleClip`).
#[derive(Debug, Clone, PartialEq)]
pub struct AssembleClip {
    /// WAV de la réplique.
    pub file: String,
    /// Position dans le tronçon (s, 0 = début du tronçon).
    pub at: f64,
    /// Accélération (`atempo`), 1 = aucune.
    pub tempo: f64,
}

/// Arguments de ffmpeg pour un montage (contrat : identiques à ceux de Node).
pub fn assemble_args(clips: &[AssembleClip], duration: f64, out_file: &str) -> Vec<String> {
    let sr = DUB_SAMPLE_RATE;
    let mut args: Vec<String> = ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-t"]
        .map(String::from)
        .to_vec();
    args.push(to_fixed(js::max(0.1, duration), 3));
    args.push("-i".into());
    args.push(format!("anullsrc=r={sr}:cl=mono"));
    for c in clips {
        args.push("-i".into());
        args.push(c.file.clone());
    }
    if clips.is_empty() {
        args.extend(["-map".into(), "0:a".into()]);
    } else {
        let chains: Vec<String> = clips
            .iter()
            .enumerate()
            .map(|(k, c)| {
                let tempo = if c.tempo > 1.001 {
                    format!(",atempo={}", to_fixed(c.tempo, 3))
                } else {
                    String::new()
                };
                let delay = js::max(0.0, js::round(c.at * sr as f64));
                format!(
                    "[{}:a]aresample={sr},aformat=sample_fmts=fltp:channel_layouts=mono{tempo},adelay=delays={}S:all=1[c{k}]",
                    k + 1,
                    js_number_string(delay)
                )
            })
            .collect();
        // Répliques sans chevauchement : simple somme (normalize=0), longueur fixée par le silence.
        let inputs: String = (0..clips.len()).map(|k| format!("[c{k}]")).collect();
        let mix = format!(
            "[0:a]{inputs}amix=inputs={}:duration=first:dropout_transition=0:normalize=0[out]",
            clips.len() + 1
        );
        args.push("-filter_complex".into());
        args.push(format!("{};{mix}", chains.join(";")));
        args.extend(["-map".into(), "[out]".into()]);
    }
    for a in [
        "-ac",
        "1",
        "-ar",
        &sr.to_string(),
        "-c:a",
        "aac",
        "-b:a",
        "48k",
        "-movflags",
        "+faststart",
        "-f",
        "mp4",
        "-y",
        out_file,
    ] {
        args.push(a.to_string());
    }
    args
}

/// `assembleChunk` : écrit `out_file` tel quel (l'appelant écrit dans un
/// .part puis renomme). Délai : 5 min ; arrêté net par le signal.
pub async fn assemble_chunk(
    clips: &[AssembleClip],
    duration: f64,
    out_file: &str,
    signal: Option<&AbortSignal>,
) -> Result<(), String> {
    let bin = ffmpeg_bin();
    let mut child = Command::new(&bin)
        .args(assemble_args(clips, duration, out_file))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| spawn_error_text(&bin, &e))?;
    lower_priority(child.id());
    let mut err_pipe = child.stderr.take().expect("stderr");
    let mut err = String::new();
    let deadline = tokio::time::sleep(Duration::from_secs(5 * 60));
    tokio::pin!(deadline);
    let mut buf = vec![0u8; 4096];
    let mut stderr_open = true;
    let mut killed = false;
    let status = loop {
        tokio::select! {
            r = err_pipe.read(&mut buf), if stderr_open => match r {
                Ok(n) if n > 0 => keep_tail(&mut err, &String::from_utf8_lossy(&buf[..n]), 600),
                _ => stderr_open = false,
            },
            st = child.wait() => break st.ok(),
            _ = &mut deadline, if !killed => { killed = true; let _ = child.start_kill(); }
            _ = wait_aborted(signal), if !killed => { killed = true; let _ = child.start_kill(); }
        }
    };
    if let Ok(Ok(n)) =
        tokio::time::timeout(Duration::from_millis(200), err_pipe.read(&mut buf)).await
    {
        keep_tail(&mut err, &String::from_utf8_lossy(&buf[..n]), 600);
    }
    let size = std::fs::metadata(out_file).map(|m| m.len()).unwrap_or(0);
    if status.as_ref().and_then(|s| s.code()) == Some(0) && size > 0 {
        Ok(())
    } else {
        Err(format!(
            "ffmpeg montage code {}: {}",
            exit_code_text(status.as_ref()),
            js::trim(&jsre!(r"\s+").replace_all(&err, " "))
        ))
    }
}
