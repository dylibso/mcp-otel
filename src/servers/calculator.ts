import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { initializeTracing, SpanStatusCode, type Span, trace, context } from '../tracing.js';

const { tracer: serverTracer } = initializeTracing('mcp-calculator-server', '1.0.0');

const server = new McpServer({
  name: "Calculator",
  version: "1.0.0"
});

server.tool(
  "calculate",
  "Performs basic arithmetic operations",
  {
    operation: z.enum(["add", "subtract", "multiply", "divide"]),
    a: z.number(),
    b: z.number()
  },
  async ({ operation, a, b }, extra: any) => {
    // Here we are *creatively reusing* the _meta property
    // to receive the trace context from the client
    const traceContext = extra._meta?.traceContext;
    
    if (!traceContext) {
      return handleCalculation(operation, a, b);
    }

    const parentSpanContext = trace.wrapSpanContext(traceContext);
    const ctx = trace.setSpan(context.active(), parentSpanContext);
    
    return new Promise((resolve, reject) => {
      const span = serverTracer.startSpan('calculator.operation', 
        { attributes: { 'operation.type': operation } }, 
        ctx
      );
      
      try {
        span.setAttribute('calculator.a', a);
        span.setAttribute('calculator.b', b);

        const result = handleCalculation(operation, a, b);

        span.setAttribute('calculator.result', result.content[0].text);
        span.setStatus({ code: SpanStatusCode.OK });
        resolve(result);
      } catch (error) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : 'Calculator operation failed'
        });
        reject(error);
      } finally {
        span.end();
      }
    });
  }
);

function handleCalculation(operation: string, a: number, b: number) {
  let result = 0;
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
      if (b === 0) {
        throw new Error("Division by zero");
      }
      result = a / b;
      break;
  }
  
  return {
    content: [{
      type: "text" as const,
      text: String(result)
    }]
  };
}

const transport = new StdioServerTransport();
await server.connect(transport);
