import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { initializeTracing, SpanStatusCode, trace, context, Span } from '../tracing.js';

// Initialize tracing for the server
const { tracer: serverTracer } = await initializeTracing('mcp-calculator-server', '1.0.0');

const server = new McpServer({
  name: "calculator",
  version: "1.0.0",
});

server.tool(
  "calculate",
  "Perform basic arithmetic operations",
  {
    operation: z.enum(["add", "subtract", "multiply", "divide"]),
    a: z.number(),
    b: z.number()
  },
  async ({ operation, a, b }, extra: any) => {
    console.error('Calculator received extra:', JSON.stringify(extra, null, 2));
    const traceContext = extra._meta?.__traceContext;
    
    if (!traceContext) {
      console.error('No trace context received from client');
      return {
        content: [{
          type: "text" as const,
          text: "Error: No trace context"
        }]
      };
    }
    
    console.error('Received trace context:', traceContext);
    
    // Reconstruct the parent span context from the trace context
    const parentSpanContext = trace.wrapSpanContext(traceContext);
    const ctx = trace.setSpan(context.active(), parentSpanContext);
    
    return serverTracer.startActiveSpan('calculator.operation', {}, ctx, async (span: Span) => {
      try {
        span.setAttribute('calculator.operation', operation);
        span.setAttribute('calculator.operand.a', a);
        span.setAttribute('calculator.operand.b', b);
        
        // Set input.value
        span.setAttribute('input.value', JSON.stringify({ operation, a, b }));
        
        let result: number;
        switch (operation) {
          case "add":
            result = a + b;
            break;
          case "subtract":
            result = a - b;
            break;
          case "multiply":
            result = a * b;
            break;
          case "divide":
            if (b === 0) throw new Error("Division by zero");
            result = a / b;
            break;
          default:
            throw new Error(`Unknown operation: ${operation}`);
        }
        
        span.setAttribute('calculator.result', result);
        
        // Set output.value
        span.setAttribute('output.value', JSON.stringify({ result }));
        
        span.setStatus({ code: SpanStatusCode.OK });
        return {
          content: [{
            type: "text" as const,
            text: String(result)
          }]
        };
      } catch (error) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : 'Calculation failed'
        });
        throw error;
      } finally {
        span.end();
      }
    });
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("Calculator server running on stdio");
