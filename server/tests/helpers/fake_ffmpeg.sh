#!/bin/sh
# Faux ffmpeg des tests du montage (doublage) : écrit ses arguments, un par
# ligne, dans $FAKE_FFMPEG_LOG, et un fichier non vide à la sortie (dernier
# argument). Utilisé par node-fixtures-dub.mts (Node) et tests/dub_node.rs
# (Rust) : les deux montages doivent passer exactement les mêmes arguments.
printf '%s\n' "$@" > "$FAKE_FFMPEG_LOG"
for last; do :; done
printf 'm4a' > "$last"
