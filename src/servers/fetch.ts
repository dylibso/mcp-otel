import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { initializeTracing, SpanStatusCode, type Span, trace, context } from '../tracing.js';
import fetch from 'node-fetch';
import TurndownService from 'turndown';

const { tracer: serverTracer } = initializeTracing('mcp-fetch-server', '1.0.0');

const server = new McpServer({
  name: "Fetch",
  version: "1.0.0"
});

const turndownService = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced'
});

server.tool(
  "fetch",
  "Fetches a URL and converts the content to markdown",
  {
    url: z.string().url()
  },
  async ({ url }, extra: any) => {
    // Here we are *creatively reusing* the _meta property
    // to receive the trace context from the client
    const traceContext = extra._meta?.__traceContext;
    
    if (!traceContext) {
      return handleFetch(url);
    }

    const parentSpanContext = trace.wrapSpanContext(traceContext);
    const ctx = trace.setSpan(context.active(), parentSpanContext);
    
    return new Promise(async (resolve, reject) => {
      const span = serverTracer.startSpan('fetch.operation', 
        { attributes: { 'fetch.url': url } }, 
        ctx
      );
      
      try {
        const fetchSpan = serverTracer.startSpan('fetch.http_request', 
          { attributes: { 'http.url': url } },
          trace.setSpan(context.active(), span)
        );

        const response = await fetch(url);
        const html = await response.text();

        fetchSpan.setAttribute('http.status_code', response.status);
        fetchSpan.setAttribute('http.response_content_length', html.length);
        fetchSpan.setStatus({ code: SpanStatusCode.OK });
        fetchSpan.end();

        const markdownSpan = serverTracer.startSpan('fetch.markdown_conversion',
          { attributes: { 'markdown.input_length': html.length } },
          trace.setSpan(context.active(), span)
        );

        const markdown = turndownService.turndown(html);
        
        markdownSpan.setAttribute('markdown.output_length', markdown.length);
        markdownSpan.setStatus({ code: SpanStatusCode.OK });
        markdownSpan.end();

        span.setAttribute('fetch.status_code', response.status);
        span.setAttribute('fetch.content_length', markdown.length);
        span.setStatus({ code: SpanStatusCode.OK });
        
        resolve({
          content: [{
            type: "text" as const,
            text: markdown
          }]
        });
      } catch (error) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : 'Fetch operation failed'
        });
        reject(error);
      } finally {
        span.end();
      }
    });
  }
);

async function handleFetch(url: string) {
  const response = await fetch(url);
  const html = await response.text();
  const markdown = turndownService.turndown(html);
  
  return {
    content: [{
      type: "text" as const,
      text: markdown
    }]
  };
}

const transport = new StdioServerTransport();
await server.connect(transport);
