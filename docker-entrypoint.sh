#!/bin/sh
# Un volume monté sur /data REMPLACE le répertoire de l'image : le
# `chown node:node` fait au build est perdu. Sur Unraid, le dossier hôte
# appartient souvent à root (ou à nobody:users), et l'utilisateur `node`
# (uid 1000) ne peut alors ni créer ni ouvrir la base SQLite
# (« unable to open database file »).
#
# Le conteneur démarre donc en root, rend /data à `node`, puis lâche les
# privilèges avant de lancer l'application. Lancé avec `--user`, il ne
# touche à rien et démarre directement.
set -e

DATA="${DATA_DIR:-/data}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA"
  # chown -R seulement si un fichier n'appartient pas à node : évite de
  # reparcourir le volume à chaque démarrage.
  if [ -n "$(find "$DATA" \( ! -user node -o ! -group node \) -print -quit)" ]; then
    chown -R node:node "$DATA"
  fi
  # setpriv garde HOME=/root : Ollama y chercherait sa clé (~/.ollama/id_ed25519)
  # et Python son cache, dans un dossier interdit à `node`.
  export HOME=/home/node
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi

exec "$@"
