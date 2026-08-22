package example.logging;

import java.io.PrintWriter;
import java.io.StringWriter;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;

// Java sibling of fixtures/typescript/winston-datadog/src/logger.ts's two
// layouts, hand-rolled rather than through a logging framework: build.sh
// only ever curls aws-lambda-java-core, the same as java/hello's does, and a
// real structured logger (log4j2, slf4j+logback) would drag in several more
// jars just to control text that this class already fully controls itself.
public final class DatadogLog {
    private static final String SERVICE = "orders-api";
    private static final String DD_SOURCE = "java";
    private static final String DD_TAGS = "env:local,fixture:structured-logging";

    // Winston's own bookkeeping keys, kept out of both layouts' free-form
    // metadata the same way logger.ts's RESERVED set does.
    private static final String STACK = "stack";
    private static final String ERROR_KIND = "errorKind";
    private static final String ERROR_MESSAGE = "errorMessage";

    private final boolean json;

    public DatadogLog(boolean json) {
        this.json = json;
    }

    public void debug(String message, Map<String, Object> meta) { log("DEBUG", "debug", message, meta); }
    public void info(String message, Map<String, Object> meta) { log("INFO", "info", message, meta); }
    public void warn(String message, Map<String, Object> meta) { log("WARN", "warn", message, meta); }
    public void error(String message, Map<String, Object> meta) { log("ERROR", "error", message, meta); }

    // Insertion-ordered on purpose: Map.of()'s iteration order is
    // unspecified for two or more entries, which would make both layouts'
    // field order flap from run to run.
    public static Map<String, Object> meta(Object... keysAndValues) {
        Map<String, Object> m = new LinkedHashMap<>();
        for (int i = 0; i + 1 < keysAndValues.length; i += 2) {
            m.put(String.valueOf(keysAndValues[i]), keysAndValues[i + 1]);
        }
        return m;
    }

    public static Map<String, Object> errorMeta(String orderId, Throwable t) {
        return meta("order_id", orderId, ERROR_KIND, t.getClass().getSimpleName(),
            ERROR_MESSAGE, t.getMessage(), STACK, stackOf(t));
    }

    private static String stackOf(Throwable t) {
        StringWriter sw = new StringWriter();
        t.printStackTrace(new PrintWriter(sw));
        String s = sw.toString();
        // printStackTrace ends with a trailing newline; the field should
        // read the same as node's Error.stack, which has none.
        return s.endsWith(System.lineSeparator())
            ? s.substring(0, s.length() - System.lineSeparator().length()) : s;
    }

    private void log(String textLevel, String status, String message, Map<String, Object> meta) {
        String timestamp = Instant.now().toString();
        Map<String, Object> m = meta == null ? Map.of() : meta;
        System.out.println(json ? toJsonLine(timestamp, status, message, m) : toTextLine(timestamp, textLevel, message, m));
    }

    private String toTextLine(String timestamp, String level, String message, Map<String, Object> meta) {
        StringBuilder rest = new StringBuilder();
        String frames = null;
        for (Map.Entry<String, Object> e : meta.entrySet()) {
            if (e.getKey().equals(STACK)) {
                frames = framesOnly(String.valueOf(e.getValue()));
                continue;
            }
            if (rest.length() > 0) rest.append(' ');
            rest.append(e.getKey()).append('=').append(renderValue(e.getValue()));
        }
        StringBuilder line = new StringBuilder()
            .append(timestamp).append(' ').append(pad(level, 5)).append(' ').append(message);
        if (rest.length() > 0) line.append("  ").append(rest);
        if (frames != null) line.append('\n').append(frames);
        return line.toString();
    }

    // Winston's fixture drops the exception's own "Type: message" header
    // line before appending frames — our own log message already covers it,
    // and printing it a second time would put the exception's header back at
    // column 0, where the Logs tab starts a new row instead of folding it in.
    private static String framesOnly(String stack) {
        int nl = stack.indexOf('\n');
        return nl < 0 ? "" : stack.substring(nl + 1);
    }

    private static String renderValue(Object value) {
        String text = String.valueOf(value);
        // Unquoted whitespace would break `key=value` back apart when read.
        return containsWhitespace(text) ? Json.stringify(text) : text;
    }

    private static boolean containsWhitespace(String text) {
        for (int i = 0; i < text.length(); i++) if (Character.isWhitespace(text.charAt(i))) return true;
        return false;
    }

    private static String pad(String s, int width) {
        StringBuilder sb = new StringBuilder(s);
        while (sb.length() < width) sb.append(' ');
        return sb.toString();
    }

    private String toJsonLine(String timestamp, String status, String message, Map<String, Object> meta) {
        Map<String, Object> line = new LinkedHashMap<>();
        line.put("timestamp", timestamp);
        line.put("status", status);
        line.put("message", message);
        line.put("service", SERVICE);
        line.put("ddsource", DD_SOURCE);
        line.put("ddtags", DD_TAGS);

        Object stack = meta.get(STACK);
        for (Map.Entry<String, Object> e : meta.entrySet()) {
            if (e.getKey().equals(STACK) || e.getKey().equals(ERROR_KIND) || e.getKey().equals(ERROR_MESSAGE)) continue;
            line.put(e.getKey(), e.getValue());
        }
        // Datadog's error tracking reads these three specifically.
        if (stack != null) {
            line.put("error", meta("kind", meta.get(ERROR_KIND), "message", meta.get(ERROR_MESSAGE), STACK, stack));
        }
        return Json.stringify(line);
    }
}
