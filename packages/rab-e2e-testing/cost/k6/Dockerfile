# D-Q6 realistic journeys: the official k6 image, pinned by digest (grafana/k6 v2.3.0, pulled 2026-11-06), plus this
# folder's scripts. Built by lib/k6-run.js as crewflow-cost/k6:<content hash>; runs on crewflow-cost-net with no bind
# mounts and with usage reporting off (--no-usage-report and K6_NO_USAGE_REPORT=true: k6 otherwise sends anonymous
# usage statistics to Grafana).
FROM grafana/k6@sha256:3e4186aea62e11a45560bfc51e19eeafe82fc07ce069c78aff44b7ff893d9a5e
ENV K6_NO_USAGE_REPORT=true
COPY lib.js profile.js journeys.js main.js /scripts/
WORKDIR /scripts
ENTRYPOINT ["k6", "run", "--no-usage-report", "--quiet", "--no-color", "main.js"]
