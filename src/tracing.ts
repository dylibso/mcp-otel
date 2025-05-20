import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { trace, Span, context, SpanStatusCode, Tracer } from '@opentelemetry/api';

// TODO override with env var
const OTLP_ENDPOINT = 'http://localhost:4318';

interface TracingSetup {
  sdk: NodeSDK;
  tracer: Tracer;
}

export function initializeTracing(serviceName: string, version: string): TracingSetup {
  const otlpExporter = new OTLPTraceExporter({
    url: `${OTLP_ENDPOINT}/v1/traces`,
  });

  const spanProcessor = new BatchSpanProcessor(otlpExporter);

  const sdk = new NodeSDK({
    serviceName: serviceName,
    autoDetectResources: false,
    spanProcessor: spanProcessor,
    instrumentations: [getNodeAutoInstrumentations()]
  });

  try {
    sdk.start();
    console.error(`OpenTelemetry SDK initialized for ${serviceName} - sending traces to ${OTLP_ENDPOINT}`);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Error initializing OpenTelemetry:', errorMessage);
  }

  process.on('SIGTERM', () => {
    sdk.shutdown()
      .then(() => console.error('SDK shut down successfully'))
      .catch((error: unknown) => {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.error('Error shutting down SDK:', errorMessage);
      })
      .finally(() => process.exit(0));
  });

  const tracer = trace.getTracer(serviceName, version);
  return { sdk, tracer };
}

export { trace, context, SpanStatusCode };
export type { Span };
