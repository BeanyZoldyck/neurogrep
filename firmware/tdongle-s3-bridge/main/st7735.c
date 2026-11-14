// Minimal ST7735S driver for the LilyGo T-Dongle-S3 panel.
//
// The board wires a 0.96" 160x80 ST7735S with a 26/1 pixel offset, inverted
// colours and BGR order (same as LilyGo's esp_lcd driver: set_gap(1,26),
// invert_color(true), swap_xy, mirror(false,true)). Landscape is rotation 1,
// i.e. MADCTL = MY|MV|BGR = 0xA8, with the window offset by x+1 / y+26.
//
// The backlight on GPIO38 is active LOW.

#include "st7735.h"

#include <string.h>

#include "driver/gpio.h"
#include "driver/ledc.h"
#include "driver/spi_master.h"
#include "esp_log.h"
#include "font5x7.h"

#define PIN_SCLK 5
#define PIN_MOSI 3
#define PIN_CS   4
#define PIN_DC   2
#define PIN_RST  1
#define PIN_BL   38

#define X_OFF 1
#define Y_OFF 26

#define SPI_HOST_USED SPI2_HOST
#define SPI_CLOCK_HZ  (40 * 1000 * 1000)

static const char *TAG = "lcd";

static spi_device_handle_t s_spi;
static uint16_t s_fb[LCD_W * LCD_H];

// ST7735 command set used here
#define CMD_SWRESET 0x01
#define CMD_SLPOUT  0x11
#define CMD_NORON   0x13
#define CMD_INVOFF  0x20
#define CMD_INVON   0x21
#define CMD_DISPON  0x29
#define CMD_CASET   0x2A
#define CMD_RASET   0x2B
#define CMD_RAMWR   0x2C
#define CMD_MADCTL  0x36
#define CMD_COLMOD  0x3A
#define CMD_FRMCTR1 0xB1
#define CMD_FRMCTR2 0xB2
#define CMD_FRMCTR3 0xB3
#define CMD_INVCTR  0xB4
#define CMD_PWCTR1  0xC0
#define CMD_PWCTR2  0xC1
#define CMD_PWCTR3  0xC2
#define CMD_PWCTR4  0xC3
#define CMD_PWCTR5  0xC4
#define CMD_VMCTR1  0xC5
#define CMD_GMCTRP1 0xE0
#define CMD_GMCTRN1 0xE1

static inline void cs_low(void) { gpio_set_level(PIN_CS, 0); }
static inline void cs_high(void) { gpio_set_level(PIN_CS, 1); }

static void spi_send(const uint8_t *data, size_t len) {
  if (len == 0) return;
  spi_transaction_t t = {
      .length = len * 8,
      .tx_buffer = data,
  };
  ESP_ERROR_CHECK(spi_device_polling_transmit(s_spi, &t));
}

static void lcd_cmd(uint8_t cmd) {
  gpio_set_level(PIN_DC, 0);
  cs_low();
  spi_send(&cmd, 1);
  cs_high();
}

static void lcd_data(const uint8_t *data, size_t len) {
  gpio_set_level(PIN_DC, 1);
  cs_low();
  spi_send(data, len);
  cs_high();
}

static void lcd_cmd_data(uint8_t cmd, const uint8_t *data, size_t len) {
  gpio_set_level(PIN_DC, 0);
  cs_low();
  spi_send(&cmd, 1);
  gpio_set_level(PIN_DC, 1);
  spi_send(data, len);
  cs_high();
}

static void set_window(int x, int y, int w, int h) {
  uint8_t cas[4] = {
      (uint8_t)((x + X_OFF) >> 8), (uint8_t)(x + X_OFF),
      (uint8_t)((x + X_OFF + w - 1) >> 8), (uint8_t)(x + X_OFF + w - 1)};
  uint8_t ras[4] = {
      (uint8_t)((y + Y_OFF) >> 8), (uint8_t)(y + Y_OFF),
      (uint8_t)((y + Y_OFF + h - 1) >> 8), (uint8_t)(y + Y_OFF + h - 1)};
  lcd_cmd_data(CMD_CASET, cas, 4);
  lcd_cmd_data(CMD_RASET, ras, 4);
}

static void panel_init(void) {
  gpio_set_level(PIN_RST, 0);
  vTaskDelay(pdMS_TO_TICKS(20));
  gpio_set_level(PIN_RST, 1);
  vTaskDelay(pdMS_TO_TICKS(120));

  lcd_cmd(CMD_SWRESET);
  vTaskDelay(pdMS_TO_TICKS(150));
  lcd_cmd(CMD_SLPOUT);
  vTaskDelay(pdMS_TO_TICKS(120));

  const uint8_t frmctr1[] = {0x05, 0x3A, 0x3A};
  const uint8_t frmctr3[] = {0x05, 0x3A, 0x3A, 0x05, 0x3A, 0x3A};
  const uint8_t invctr[] = {0x03};
  const uint8_t pwctr1[] = {0x62, 0x02, 0x04};
  const uint8_t pwctr2[] = {0xC0};
  const uint8_t pwctr3[] = {0x0D, 0x00};
  const uint8_t pwctr4[] = {0x8D, 0x6A};
  const uint8_t pwctr5[] = {0x8D, 0xEE};
  const uint8_t vmctr1[] = {0x0E};
  const uint8_t colmod[] = {0x05};  // 16 bit/px
  const uint8_t madctl[] = {0xA8};  // MY|MV|BGR -> landscape
  const uint8_t gmctrp1[] = {0x10, 0x0E, 0x02, 0x03, 0x0E, 0x07, 0x02, 0x07,
                             0x0A, 0x12, 0x27, 0x37, 0x00, 0x0D, 0x0E, 0x10};
  const uint8_t gmctrn1[] = {0x10, 0x0E, 0x03, 0x03, 0x0F, 0x06, 0x02, 0x08,
                             0x0A, 0x13, 0x26, 0x36, 0x00, 0x0D, 0x0E, 0x10};

  lcd_cmd_data(CMD_FRMCTR1, frmctr1, sizeof(frmctr1));
  lcd_cmd_data(CMD_FRMCTR2, frmctr1, sizeof(frmctr1));
  lcd_cmd_data(CMD_FRMCTR3, frmctr3, sizeof(frmctr3));
  lcd_cmd_data(CMD_INVCTR, invctr, sizeof(invctr));
  lcd_cmd_data(CMD_PWCTR1, pwctr1, sizeof(pwctr1));
  lcd_cmd_data(CMD_PWCTR2, pwctr2, sizeof(pwctr2));
  lcd_cmd_data(CMD_PWCTR3, pwctr3, sizeof(pwctr3));
  lcd_cmd_data(CMD_PWCTR4, pwctr4, sizeof(pwctr4));
  lcd_cmd_data(CMD_PWCTR5, pwctr5, sizeof(pwctr5));
  lcd_cmd_data(CMD_VMCTR1, vmctr1, sizeof(vmctr1));
  lcd_cmd(CMD_INVON);  // this panel is inverted relative to the datasheet default
  lcd_cmd_data(CMD_COLMOD, colmod, sizeof(colmod));
  lcd_cmd_data(CMD_MADCTL, madctl, sizeof(madctl));
  lcd_cmd_data(CMD_GMCTRP1, gmctrp1, sizeof(gmctrp1));
  lcd_cmd_data(CMD_GMCTRN1, gmctrn1, sizeof(gmctrn1));
  lcd_cmd(CMD_NORON);
  vTaskDelay(pdMS_TO_TICKS(10));
  lcd_cmd(CMD_DISPON);
  vTaskDelay(pdMS_TO_TICKS(120));
}

esp_err_t lcd_init(void) {
  gpio_config_t io = {
      .pin_bit_mask = (1ULL << PIN_CS) | (1ULL << PIN_DC) | (1ULL << PIN_RST),
      .mode = GPIO_MODE_OUTPUT,
  };
  ESP_ERROR_CHECK(gpio_config(&io));
  gpio_set_level(PIN_CS, 1);
  gpio_set_level(PIN_DC, 1);
  gpio_set_level(PIN_RST, 0);

  spi_bus_config_t bus = {
      .mosi_io_num = PIN_MOSI,
      .miso_io_num = -1,
      .sclk_io_num = PIN_SCLK,
      .quadwp_io_num = -1,
      .quadhd_io_num = -1,
      .max_transfer_sz = 16 * 1024,
  };
  ESP_ERROR_CHECK(spi_bus_initialize(SPI_HOST_USED, &bus, SPI_DMA_CH_AUTO));

  spi_device_interface_config_t dev = {
      .clock_speed_hz = SPI_CLOCK_HZ,
      .mode = 0,
      .spics_io_num = -1,  // driven manually so a command and its data stay in one CS frame
      .queue_size = 1,
  };
  ESP_ERROR_CHECK(spi_bus_add_device(SPI_HOST_USED, &dev, &s_spi));

  panel_init();

  // Backlight: LEDC, active low, so full brightness is duty 0.
  ledc_timer_config_t t = {
      .speed_mode = LEDC_LOW_SPEED_MODE,
      .duty_resolution = LEDC_TIMER_8_BIT,
      .timer_num = LEDC_TIMER_0,
      .freq_hz = 5000,
      .clk_cfg = LEDC_AUTO_CLK,
  };
  ESP_ERROR_CHECK(ledc_timer_config(&t));
  ledc_channel_config_t ch = {
      .gpio_num = PIN_BL,
      .speed_mode = LEDC_LOW_SPEED_MODE,
      .channel = LEDC_CHANNEL_0,
      .timer_sel = LEDC_TIMER_0,
      .duty = 255,
      .hpoint = 0,
  };
  ESP_ERROR_CHECK(ledc_channel_config(&ch));

  lcd_clear(0);
  lcd_flush();
  ESP_LOGI(TAG, "ST7735 up (%dx%d)", LCD_W, LCD_H);
  return ESP_OK;
}

void lcd_backlight(uint8_t level) {
  uint32_t duty = (uint32_t)(255 - level);  // active low
  ledc_set_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0, duty);
  ledc_update_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0);
}

const uint16_t *lcd_fb(void) { return s_fb; }

void lcd_flush(void) {
  set_window(0, 0, LCD_W, LCD_H);
  lcd_cmd(CMD_RAMWR);

  const uint8_t *p = (const uint8_t *)s_fb;
  size_t left = sizeof(s_fb);
  gpio_set_level(PIN_DC, 1);
  cs_low();
  while (left) {
    size_t chunk = left > 8192 ? 8192 : left;
    spi_transaction_t t = {.length = chunk * 8, .tx_buffer = p};
    ESP_ERROR_CHECK(spi_device_polling_transmit(s_spi, &t));
    p += chunk;
    left -= chunk;
  }
  cs_high();
}

// The panel wants big-endian RGB565, so the canvas keeps swapped values and
// every write goes through this.
static inline uint16_t be(uint16_t c) { return (uint16_t)((c >> 8) | (c << 8)); }

void lcd_pixel(int x, int y, uint16_t colour) {
  if ((unsigned)x >= LCD_W || (unsigned)y >= LCD_H) return;
  s_fb[y * LCD_W + x] = be(colour);
}

void lcd_fill(int x, int y, int w, int h, uint16_t colour) {
  uint16_t c = be(colour);
  for (int yy = y; yy < y + h; yy++) {
    if ((unsigned)yy >= LCD_H) continue;
    for (int xx = x; xx < x + w; xx++) {
      if ((unsigned)xx >= LCD_W) continue;
      s_fb[yy * LCD_W + xx] = c;
    }
  }
}

void lcd_hline(int x, int y, int w, uint16_t colour) { lcd_fill(x, y, w, 1, colour); }

void lcd_clear(uint16_t colour) { lcd_fill(0, 0, LCD_W, LCD_H, colour); }

int lcd_text_width(const char *s, uint8_t size) {
  return (int)strlen(s) * 6 * size;
}

void lcd_text(int x, int y, const char *s, uint8_t size, uint16_t colour) {
  for (; *s; s++) {
    unsigned char ch = (unsigned char)*s;
    if (ch < FONT_FIRST_CHAR || ch > FONT_LAST_CHAR) {
      x += 6 * size;
      continue;
    }
    const uint8_t *glyph = &font5x7[(ch - FONT_FIRST_CHAR) * FONT_WIDTH];
    for (int i = 0; i < FONT_WIDTH; i++) {
      uint8_t line = glyph[i];
      for (int j = 0; j < 8; j++) {
        if (line & (1 << j)) {
          lcd_fill(x + i * size, y + j * size, size, size, colour);
        }
      }
    }
    x += 6 * size;
  }
}

void lcd_text_shadow(int x, int y, const char *s, uint8_t size, uint16_t colour) {
  lcd_text(x + 1, y + 1, s, size, 0x0000);
  lcd_text(x, y, s, size, colour);
}

void lcd_text_centered(int y, const char *s, uint8_t size, uint16_t colour) {
  int x = (LCD_W - lcd_text_width(s, size)) / 2;
  lcd_text_shadow(x, y, s, size, colour);
}
