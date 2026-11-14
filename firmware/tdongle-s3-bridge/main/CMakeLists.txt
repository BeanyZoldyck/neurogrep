idf_component_register(
    SRCS "app_main.c" "ui.c" "st7735.c" "font5x7.c"
    INCLUDE_DIRS "."
    REQUIRES driver esp_wifi esp_event nvs_flash esp_tinyusb
)
