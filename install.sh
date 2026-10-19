#!/usr/bin/env sh
# Prépare un fichier .env avec des secrets aléatoires, puis démarre Vercio.
set -eu

if [ -f .env ]; then
  echo ".env existe déjà : rien n'est modifié."
else
  printf "URL publique de Vercio (ex. https://vercio.example.com) : "
  read -r public_url
  random() { head -c 48 /dev/urandom | base64 | tr -d '/+=\n' | cut -c1-"$1"; }
  setup_code=$(random 12)
  cat > .env <<ENV
PUBLIC_URL=${public_url}
VERCIO_SECRET_KEY=$(random 48)
DB_PASSWORD=$(random 32)
VERCIO_SETUP_CODE=${setup_code}
TZ=Europe/Paris
ENV
  chmod 600 .env
  echo
  echo "Ouvrez ${public_url} pour créer le compte administrateur."
  echo "Code d'installation demandé : ${setup_code} (également enregistré dans .env)"
fi

docker compose up -d
