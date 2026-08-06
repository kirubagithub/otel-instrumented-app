package com.oteldemo.catalog;

public record Product(int id, String sku, String name, int priceCents, String currency) {}
