.PHONY: dev

dev:
	docker compose -f compose.dev.yaml up -d --build
	@echo "Ladarr       http://localhost:$${LADARR_PORT:-3000}"
	@echo "Sonarr       http://localhost:$${LADARR_SONARR_PORT:-8989}"
	@echo "Radarr       http://localhost:$${LADARR_RADARR_PORT:-7878}"
	@echo "Seerr        http://localhost:$${LADARR_SEERR_PORT:-5055}"
	@echo "qBittorrent  http://localhost:$${QBITTORRENT_WEBUI_PORT:-8080}"
	@echo "Jackett      http://localhost:$${JACKETT_PORT:-9117}"
