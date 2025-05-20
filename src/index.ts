import readline from 'readline';
import { ClaudeAgent } from './agent.js';
import type { Message, ContentBlock } from '@anthropic-ai/sdk/resources/messages';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('Please set ANTHROPIC_API_KEY environment variable');
    process.exit(1);
  }

  const agent = new ClaudeAgent(apiKey);
  await agent.connect();
  
  console.log('(Press Ctrl+C to exit)\n');

  function prompt() {
    rl.question('You: ', async (input) => {
      if (input.toLowerCase() === 'exit') {
        await cleanup();
        return;
      }

      try {
        const result = await agent.chat(input);
        if (!result) {
          console.error('No response received');
          prompt();
          return;
        }

        const response = result as Message;
        const content = response.content as ContentBlock[];
        
        for (const block of content) {
          if (block.type === 'text' && 'text' in block) {
            console.log('\nAssistant:', block.text);
          }
        }
        console.log();
        prompt();
      } catch (error) {
        console.error('Error:', error);
        prompt();
      }
    });
  }

  prompt();
}

async function cleanup() {
  console.log('\nCleaning up...');
  rl.close();
  process.exit(0);
}

process.on('SIGINT', cleanup);

main().catch(console.error);