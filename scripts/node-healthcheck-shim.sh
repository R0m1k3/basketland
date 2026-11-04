#!/bin/sh
# Faux `node` de l'image : Node n'y est plus, mais d'anciens docker-compose
# (dont la copie que garde le compose manager d'Unraid, qui ne suit pas ce
# dépôt) contrôlent encore la santé avec
#   node -e "fetch('http://127.0.0.1:3012/api/health')…"
# Sans `node`, ce contrôle échoue toujours et le conteneur reste « unhealthy ».
# Ce script le redirige vers le vrai contrôle du serveur Rust.
#
# Tout autre usage échoue (code 127, comme une commande absente) : le
# serveur, qui lit `node --version` pour l'afficher, voit toujours « pas de Node ».
case "$1" in
  -e | --eval | -p | --print)
    case "$2" in
      */api/health*) exec basketland-server health ;;
    esac
    ;;
esac
echo "node : absent de cette image (seul l'ancien contrôle de santé est pris en charge)" >&2
exit 127
