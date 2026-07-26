# Superset + the Postgres driver (the base image ships without one).
FROM apache/superset:4.1.1
USER root
RUN pip install --no-cache-dir psycopg2-binary==2.9.9
USER superset
