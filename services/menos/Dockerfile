FROM python:3.12-slim

WORKDIR /app

# Install uv for fast dependency management
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

# Copy project files
COPY pyproject.toml .
COPY menos/ menos/
COPY migrations/ migrations/

# Install dependencies
RUN uv pip install --system -e .

# Version metadata (placed last to avoid cache busting)
ARG GIT_SHA=unknown
ARG BUILD_DATE=unknown
ENV GIT_SHA=$GIT_SHA
ENV BUILD_DATE=$BUILD_DATE

EXPOSE 8000

CMD ["uvicorn", "menos.main:app", "--host", "0.0.0.0", "--port", "8000"]
