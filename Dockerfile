# TeleVisita è una SPA 100% client-side: nessun backend, nessun database, nessuna
# variabile d'ambiente da configurare. Basta servire i file statici già pronti in docs/
# (è la stessa cartella che GitHub Pages pubblica oggi) con un web server qualsiasi.
#
# Build: docker build -t televisita .
# Run:   docker run -d -p 8080:80 --name televisita televisita
# App disponibile su: http://localhost:8080/

FROM nginx:alpine

COPY docs/ /usr/share/nginx/html/

EXPOSE 80
