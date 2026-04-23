const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

/**
 * Simple test: Does DexPaprika support PreGrad or PostGrad?
 */

async function fetchTokens() {
  try {
    const response = await fetch('https://api.dexscreener.com/latest/dex/tokens?order=volume&limit=50');
    const data = await response.json();

    const pregrad = data.pairs
      ?.filter((p: any) => p.dexId === 'pumpfun')
      ?.slice(0, 3)
      ?.map((p: any) => p.baseToken.address) || [];

    const postgrad = data.pairs
      ?.filter((p: any) => p.dexId === 'raydium' || p.dexId === 'orca')
      ?.slice(0, 3)
      ?.map((p: any) => p.baseToken.address) || [];

    return { pregrad, postgrad };
  } catch (error) {
    return {
      pregrad: ['BuZJLGixoCeR36vug21j3gM6B2kNywSFKJ8kSr9q5yt'],
      postgrad: ['EPjFWaLb3odcjGVY9wn9Qo0iRjb3FSPmN9h2yeP7qdc']
    };
  }
}

async function testToken(mint: string) {
  try {
    // Correct DexPaprika SSE endpoint: GET https://streaming.dexpaprika.com/stream
    // with query params: chain=solana, address={mint}, method=t_p
    const url = new URL('https://streaming.dexpaprika.com/stream');
    url.searchParams.set('chain', 'solana');
    url.searchParams.set('address', mint);
    url.searchParams.set('method', 't_p');

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Accept': 'text/event-stream'
      },
      // Timeout after 3 seconds (just checking if endpoint responds, not full stream)
      signal: AbortSignal.timeout(3000)
    });

    return { status: response.status, ok: response.ok };
  } catch (error) {
    const errMsg = (error as Error).message;
    // Distinguish between timeout and actual errors
    const isTimeout = errMsg.includes('AbortError') || errMsg.includes('timeout');
    return { status: 0, ok: false, error: errMsg, timeout: isTimeout };
  }
}

app.get('/api/test', async (req: any, res: any) => {
  try {
    const { pregrad, postgrad } = await fetchTokens();

    console.log('\n🧪 Testing DexPaprika Token Support\n');

    const results: any = {
      pregrad_supported: false,
      postgrad_supported: false,
      pregrad_tokens: [],
      postgrad_tokens: [],
      pregrad_results: [],
      postgrad_results: []
    };

    console.log('Testing PreGrad (bonding curve)...');
    for (const mint of pregrad) {
      const result = await testToken(mint);
      results.pregrad_results.push({ mint, ...result });
      if (result.ok) results.pregrad_supported = true;
      console.log(`  ${mint.slice(0, 8)}... → HTTP ${result.status} ${result.ok ? '✅' : '❌'}`);
    }

    console.log('\nTesting PostGrad (graduated)...');
    for (const mint of postgrad) {
      const result = await testToken(mint);
      results.postgrad_results.push({ mint, ...result });
      if (result.ok) results.postgrad_supported = true;
      console.log(`  ${mint.slice(0, 8)}... → HTTP ${result.status} ${result.ok ? '✅' : '❌'}`);
    }

    console.log('\n📊 RESULT:');
    if (results.pregrad_supported && results.postgrad_supported) {
      console.log('✅ DexPaprika supports BOTH PreGrad and PostGrad');
    } else if (results.pregrad_supported) {
      console.log('🟡 DexPaprika supports ONLY PreGrad');
    } else if (results.postgrad_supported) {
      console.log('🟡 DexPaprika supports ONLY PostGrad');
    } else {
      console.log('❌ DexPaprika supports NEITHER (or API issue)');
    }

    res.json(results);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

app.get('/health', (req: any, res: any) => {
  res.json({ ok: true });
});

app.get('/', (req: any, res: any) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🚀 DexPaprika PreGrad vs PostGrad Test\n`);
  console.log(`📍 http://localhost:${PORT}\n`);
});
