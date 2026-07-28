package example;

import com.amazonaws.services.lambda.runtime.Context;
import com.amazonaws.services.lambda.runtime.RequestHandler;
import java.util.LinkedHashMap;
import java.util.Map;

public class Hello implements RequestHandler<Map<String, Object>, Map<String, Object>> {
    @Override
    public Map<String, Object> handleRequest(Map<String, Object> event, Context context) {
        context.getLogger().log("hello from java logger");
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("message", "hello from java");
        out.put("echo", event);
        out.put("requestId", context.getAwsRequestId());
        return out;
    }
}
