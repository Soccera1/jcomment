#include <stddef.h>
#include <stdint.h>

#define AUTHOR_CAP 96u
#define BODY_CAP 2048u
#define TIME_CAP 64u
#define SCORE_CAP 32u
#define OUT_CAP 4096u

static uint8_t author_buf[AUTHOR_CAP];
static uint8_t body_buf[BODY_CAP];
static uint8_t time_buf[TIME_CAP];
static uint8_t score_buf[SCORE_CAP];
static char out_buf[OUT_CAP];
static uint32_t out_len = 0;

uint32_t jcomment_author_ptr(void) { return (uint32_t)(uintptr_t)author_buf; }
uint32_t jcomment_body_ptr(void) { return (uint32_t)(uintptr_t)body_buf; }
uint32_t jcomment_time_ptr(void) { return (uint32_t)(uintptr_t)time_buf; }
uint32_t jcomment_score_ptr(void) { return (uint32_t)(uintptr_t)score_buf; }
uint32_t jcomment_output_ptr(void) { return (uint32_t)(uintptr_t)out_buf; }
uint32_t jcomment_output_len(void) { return out_len; }

static void append_byte(char c) {
  if (out_len + 1u < OUT_CAP) {
    out_buf[out_len++] = c;
  }
}

static void append_lit(const char *s) {
  while (*s) {
    append_byte(*s++);
  }
}

static void append_escaped(const uint8_t *s, uint32_t len) {
  for (uint32_t i = 0; i < len; i++) {
    uint8_t c = s[i];
    if (c == '&') {
      append_lit("&amp;");
    } else if (c == '<') {
      append_lit("&lt;");
    } else if (c == '>') {
      append_lit("&gt;");
    } else if (c == '"') {
      append_lit("&quot;");
    } else if (c == '\'') {
      append_lit("&#39;");
    } else if (c == '\n') {
      append_lit("<br>");
    } else if (c >= 32u || c == '\t') {
      append_byte((char)c);
    }
  }
}

static uint32_t clamp_len(uint32_t len, uint32_t cap) {
  return len > cap ? cap : len;
}

uint32_t jcomment_render(uint32_t author_len, uint32_t body_len, uint32_t time_len, uint32_t score_len) {
  author_len = clamp_len(author_len, AUTHOR_CAP);
  body_len = clamp_len(body_len, BODY_CAP);
  time_len = clamp_len(time_len, TIME_CAP);
  score_len = clamp_len(score_len, SCORE_CAP);
  out_len = 0;

  append_lit("<header class=\"jc-comment__meta\"><strong>");
  append_escaped(author_buf, author_len);
  append_lit("</strong><time>");
  append_escaped(time_buf, time_len);
  append_lit("</time></header><p>");
  append_escaped(body_buf, body_len);
  append_lit("</p><span class=\"jc-score\">");
  append_escaped(score_buf, score_len);
  append_lit("</span>");

  return out_len;
}
