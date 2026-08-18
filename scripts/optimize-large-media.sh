#!/usr/bin/env bash
set -euo pipefail

backup_uploads="${1:-}"
public_root="${2:-public}"
manifest="${3:-content/oversized-media.json}"

if [[ -z "${backup_uploads}" ]]; then
  echo "Usage: scripts/optimize-large-media.sh <extracted-backup-uploads> [public-dir] [manifest]" >&2
  exit 64
fi

command -v jq >/dev/null
command -v ffmpeg >/dev/null
command -v ffprobe >/dev/null
command -v gs >/dev/null

pass_dir="$(mktemp -d /tmp/jammindjs-media-pass-XXXXXX)"
trap 'rm -rf "${pass_dir}"' EXIT

mapfile -t media_rows < <(jq -r '.assets[] | [.sourceRelative, .publicPath] | @tsv' "${manifest}")
for media_row in "${media_rows[@]}"; do
  IFS=$'\t' read -r source_relative public_path <<<"${media_row}"
  source_file="${backup_uploads}/${source_relative}"
  destination="${public_root}${public_path}"
  mkdir -p "$(dirname "${destination}")"
  if [[ -f "${destination}" ]] && (( $(stat -c '%s' "${destination}") < 26214400 )); then
    echo "Already within limit: ${public_path}"
    continue
  fi

  case "${source_file,,}" in
    *.pdf)
      temporary="${destination}.tmp.pdf"
      gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=/ebook \
        -dNOPAUSE -dQUIET -dBATCH -sOutputFile="${temporary}" "${source_file}"
      if (( $(stat -c '%s' "${temporary}") >= 25000000 )); then
        rm -f "${temporary}"
        gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=/screen \
          -dNOPAUSE -dQUIET -dBATCH -sOutputFile="${temporary}" "${source_file}"
      fi
      mv "${temporary}" "${destination}"
      ;;
    *.mp4|*.mov|*.m4v)
      duration="$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "${source_file}")"
      video_bitrate="$(awk -v seconds="${duration}" 'BEGIN {
        target=(22*1024*1024*8)/seconds-96000;
        if (target < 250000) target=250000;
        if (target > 5000000) target=5000000;
        printf "%d", target;
      }')"
      pass_log="${pass_dir}/$(basename "${source_relative}")"
      temporary="${destination}.tmp.mp4"
      ffmpeg -nostdin -y -loglevel error -i "${source_file}" -map 0:v:0 \
        -c:v libx264 -preset fast -b:v "${video_bitrate}" -pass 1 \
        -passlogfile "${pass_log}" -an -f null /dev/null
      ffmpeg -nostdin -y -loglevel error -i "${source_file}" -map 0:v:0 -map 0:a:0? \
        -c:v libx264 -preset fast -b:v "${video_bitrate}" -pass 2 \
        -passlogfile "${pass_log}" -c:a aac -b:a 96k -movflags +faststart \
        "${temporary}"
      mv "${temporary}" "${destination}"
      ;;
    *)
      echo "Unsupported oversized media: ${source_relative}" >&2
      exit 65
      ;;
  esac

  bytes="$(stat -c '%s' "${destination}")"
  if (( bytes >= 26214400 )); then
    echo "Optimized asset still exceeds 25 MiB: ${destination} (${bytes} bytes)" >&2
    exit 66
  fi
  echo "Optimized ${public_path} (${bytes} bytes)"
done
