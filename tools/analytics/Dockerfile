# Superset + the Postgres driver (the base image ships without one).
FROM apache/superset:4.1.1@sha256:1d1fdaaeb19ce9cdba71620ee1cc6117d73813b2f3b422ce5a1bf752c247b7c0
USER root
RUN pip install --no-cache-dir psycopg2-binary==2.9.9
USER superset
