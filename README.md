
1. Build: docker build -t local-vr-router .
2. Run (HTTP): docker run --rm -p 3000:3000 local-vr-router
3. Run (HTTPS, required for PWA install prompts):
   docker run --rm -p 8443:8443 -e HTTPS_KEY_PATH=/certs/server.key -e
     HTTPS_CERT_PATH=/certs/server.crt -v /path/to/certs:/certs local-vr-router
# ytm2
