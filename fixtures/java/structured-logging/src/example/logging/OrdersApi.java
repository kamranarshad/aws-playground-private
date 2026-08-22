package example.logging;

import com.amazonaws.services.lambda.runtime.Context;
import com.amazonaws.services.lambda.runtime.RequestHandler;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.NoSuchElementException;

// Java sibling of fixtures/typescript/winston-datadog: the same six log
// entries and the same two layouts (text, or Datadog's JSON intake shape via
// {"format":"json"}), so the Logs tab's parser gets exercised against a
// second language's timestamp/level/stack shapes, not just node's.
public class OrdersApi implements RequestHandler<Map<String, Object>, Map<String, Object>> {
    @Override
    public Map<String, Object> handleRequest(Map<String, Object> event, Context context) {
        boolean json = "json".equals(event.get("format"));
        Object requested = event.get("orderId");
        String orderId = requested != null ? String.valueOf(requested) : "A-1001";
        DatadogLog log = new DatadogLog(json);

        log.debug("payload parsed", DatadogLog.meta("format", json ? "json" : "text"));
        log.info("fetching order", DatadogLog.meta("order_id", orderId));
        log.warn("slow downstream call", DatadogLog.meta("order_id", orderId, "duration_ms", 812));

        // Deliberately not through DatadogLog: one unadorned line, so the
        // viewer has a row with no level and no timestamp among the parsed ones.
        System.out.println("plain System.out - no level, no timestamp");

        try {
            lookupOrder(orderId);
        } catch (NoSuchElementException e) {
            log.error("order lookup failed", DatadogLog.errorMeta(orderId, e));
        }

        log.info("handler complete", DatadogLog.meta("order_id", orderId));

        Map<String, Object> body = new LinkedHashMap<>();
        body.put("ok", true);
        body.put("orderId", orderId);
        body.put("logFormat", json ? "json" : "text");

        Map<String, Object> response = new LinkedHashMap<>();
        response.put("statusCode", 200);
        response.put("headers", Map.of("content-type", "application/json"));
        response.put("body", Json.stringify(body));
        return response;
    }

    // Two frames deep, so the logged stack has something to fold in the viewer.
    private static void readFromStore(String orderId) {
        throw new NoSuchElementException("no order matching '" + orderId + "' in the local store");
    }

    private static void lookupOrder(String orderId) {
        readFromStore(orderId);
    }
}
