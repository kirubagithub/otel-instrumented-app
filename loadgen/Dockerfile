FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY locustfile.py .
EXPOSE 8089
CMD ["locust", "-f", "locustfile.py", "--host", "http://bff:3000"]
