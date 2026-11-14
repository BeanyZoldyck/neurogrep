#pragma once

#include <stdint.h>
#include "esp_err.h"

#define LCD_W 160
#define LCD_H 80

// Initialises SPI, the ST7735S panel and the (active-low) backlight.
esp_err_t lcd_init(void);

// Full-frame blit of the internal canvas.
void lcd_flush(void);

// Read-only canvas access (verification builds only). Bytes are big-endian
// RGB565 as sent to the panel.
const uint16_t *lcd_fb(void);

void lcd_clear(uint16_t colour);
void lcd_fill(int x, int y, int w, int h, uint16_t colour);
void lcd_hline(int x, int y, int w, uint16_t colour);
void lcd_pixel(int x, int y, uint16_t colour);

void lcd_text(int x, int y, const char *s, uint8_t size, uint16_t colour);
void lcd_text_shadow(int x, int y, const char *s, uint8_t size, uint16_t colour);
void lcd_text_centered(int y, const char *s, uint8_t size, uint16_t colour);
int lcd_text_width(const char *s, uint8_t size);

void lcd_backlight(uint8_t level /* 0..255 */);
