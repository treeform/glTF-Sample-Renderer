import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { rollup } from 'rollup';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import { chromium } from '@playwright/test';

// Exercise the real material parser and WebGL uploader, then read the sampled
// texel before lighting/tone mapping. RGB must decode; glossiness alpha must not.
test('specular/glossiness textures decode sRGB RGB while retaining linear alpha', async () => {
    const material = fileURLToPath(new URL('../source/gltf/material.js', import.meta.url));
    const webgl = fileURLToPath(new URL('../source/Renderer/webgl.js', import.meta.url));
    const bundle = await rollup({ input: 'test-entry', plugins: [
        { name: 'test-entry', resolveId: id => id === 'test-entry' ? '\0test-entry' : null,
            load: id => id === '\0test-entry' ?
                `export { gltfMaterial } from ${JSON.stringify(material)}; export { gltfWebGl } from ${JSON.stringify(webgl)};` : null },
        nodeResolve()
    ] });
    const { output } = await bundle.generate({ format: 'iife', name: 'SGTest' });
    await bundle.close();
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE });
    try {
        const page = await browser.newPage();
        await page.addScriptTag({ content: output[0].code });
        const result = await page.evaluate(() => {
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = 1;
            const gl = canvas.getContext('webgl2', { premultipliedAlpha: false });
            const compile = (type, body) => {
                const shader = gl.createShader(type);
                gl.shaderSource(shader, '#version 300 es\nprecision highp float;\n' + body);
                gl.compileShader(shader);
                if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw Error(gl.getShaderInfoLog(shader));
                return shader;
            };
            const program = gl.createProgram();
            gl.attachShader(program, compile(gl.VERTEX_SHADER,
                'void main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.-1.,0,1);}'));
            gl.attachShader(program, compile(gl.FRAGMENT_SHADER,
                'uniform sampler2D tex;out vec4 color;void main(){color=texture(tex,vec2(.5));}'));
            gl.linkProgram(program);
            if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(program));
            gl.useProgram(program);
            const material = new SGTest.gltfMaterial();
            material.fromJson({ extensions: { KHR_materials_pbrSpecularGlossiness: {
                diffuseTexture: { index: 0 }, specularGlossinessTexture: { index: 1 }
            } } });
            const sg = material.extensions.KHR_materials_pbrSpecularGlossiness;
            const loader = new SGTest.gltfWebGl(gl);
            const gltf = {
                textures: [0, 1].map(() => ({ source: 0, sampler: 0, type: gl.TEXTURE_2D })),
                images: [{ mimeType: 'image/png', type: gl.TEXTURE_2D, miplevel: 0,
                    image: new ImageData(new Uint8ClampedArray([128, 64, 192, 128]), 1, 1) }],
                samplers: [{ minFilter: gl.NEAREST, magFilter: gl.NEAREST,
                    wrapS: gl.CLAMP_TO_EDGE, wrapT: gl.CLAMP_TO_EDGE }]
            };
            const samples = [];
            for (const info of [sg.diffuseTexture, sg.specularGlossinessTexture]) {
                if (!loader.setTexture(gl.getUniformLocation(program, 'tex'), gltf, info, 0)) throw Error('Texture upload failed');
                gl.drawArrays(gl.TRIANGLES, 0, 3);
                const pixel = new Uint8Array(4);
                gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
                if (gl.getError() !== gl.NO_ERROR) throw Error('WebGL error');
                samples.push(Array.from(pixel));
            }
            return samples;
        });
        for (const [index, pixel] of result.entries()) {
            const expected = [55, 13, 134, 128];
            for (let channel = 0; channel < 4; channel++) {
                assert.ok(Math.abs(pixel[channel] - expected[channel]) <= 1,
                    `texture ${index}, channel ${channel}: ${pixel[channel]} != ${expected[channel]}`);
            }
        }
    } finally {
        await browser.close();
    }
});
