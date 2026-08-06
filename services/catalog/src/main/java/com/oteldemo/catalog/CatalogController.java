package com.oteldemo.catalog;

import io.opentelemetry.api.trace.Span;
import java.util.List;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
public class CatalogController {
  private final JdbcTemplate jdbc;

  public CatalogController(JdbcTemplate jdbc) {
    this.jdbc = jdbc;
  }

  @GetMapping("/health")
  public Map<String, String> health() {
    return Map.of("status", "ok", "service", "catalog-service");
  }

  @GetMapping("/products")
  public List<Map<String, Object>> listProducts() {
    Span.current().setAttribute("catalog.operation", "list");
    return jdbc.queryForList(
        "SELECT id, sku, name, price_cents AS \"priceCents\", currency FROM products ORDER BY id");
  }

  @GetMapping("/products/{id}")
  public Map<String, Object> getProduct(@PathVariable int id) {
    Span.current().setAttribute("catalog.operation", "get");
    Span.current().setAttribute("product.id", id);
    List<Map<String, Object>> rows =
        jdbc.queryForList(
            "SELECT id, sku, name, price_cents AS \"priceCents\", currency FROM products WHERE id = ?",
            id);
    if (rows.isEmpty()) {
      throw new ResponseStatusException(HttpStatus.NOT_FOUND, "product_not_found");
    }
    // Normalize key for Python client which expects price_cents
    Map<String, Object> row = rows.get(0);
    row.put("price_cents", row.get("priceCents"));
    return row;
  }
}
