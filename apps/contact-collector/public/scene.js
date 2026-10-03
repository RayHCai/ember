import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js';

const canvas = document.querySelector('#bg');
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

if (canvas && !reduced) {
    start(canvas);
}

function start(surface) {
    const renderer = new THREE.WebGLRenderer({
        canvas: surface,
        antialias: false,
        alpha: false,
        powerPreference: 'high-performance',
    });
    renderer.setClearColor(0x140804, 1);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(58, 1, 0.1, 40);
    camera.position.set(0, 0, 7);

    const texture = emberTexture();
    const count = window.innerWidth < 700 ? 700 : 1400;
    const embers = makeEmbers(count, texture);
    scene.add(embers.points);

    const glow = new THREE.Sprite(
        new THREE.SpriteMaterial({
            map: texture,
            color: 0xff4a16,
            transparent: true,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            opacity: 0.9,
        }),
    );
    glow.scale.set(10, 6, 1);
    glow.position.set(0, -3.4, -1);
    scene.add(glow);

    const spark = new THREE.Sprite(
        new THREE.SpriteMaterial({
            map: texture,
            color: 0xffc56a,
            transparent: true,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            opacity: 0.55,
        }),
    );
    spark.scale.set(3.2, 3.2, 1);
    spark.position.set(0, -1.2, 1);
    scene.add(spark);

    let pointerX = 0;
    let pointerY = 0;
    window.addEventListener('pointermove', (event) => {
        pointerX = (event.clientX / window.innerWidth - 0.5) * 1.1;
        pointerY = (event.clientY / window.innerHeight - 0.5) * 0.6;
    });

    function resize() {
        const width = window.innerWidth;
        const height = window.innerHeight;
        camera.aspect = width / Math.max(height, 1);
        camera.updateProjectionMatrix();
        renderer.setSize(width, height, false);
    }

    resize();
    window.addEventListener('resize', resize);

    const clock = new THREE.Clock();
    let frame = 0;

    function tick() {
        frame = requestAnimationFrame(tick);
        if (document.hidden) return;
        const time = clock.getElapsedTime();
        embers.material.uniforms.uTime.value = time;
        embers.points.rotation.y = time * 0.04;
        glow.material.opacity = 0.72 + Math.sin(time * 1.6) * 0.18;
        spark.position.y = -1.1 + Math.sin(time * 0.8) * 0.25;
        spark.material.opacity = 0.35 + Math.sin(time * 2.2) * 0.2;
        camera.position.x += (pointerX - camera.position.x) * 0.04;
        camera.position.y += (-pointerY - camera.position.y) * 0.04;
        camera.lookAt(0, -0.2, 0);
        renderer.render(scene, camera);
    }

    tick();

    window.addEventListener('pagehide', () => {
        cancelAnimationFrame(frame);
        renderer.dispose();
    });
}

function makeEmbers(count, texture) {
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    const speeds = new Float32Array(count);
    const phases = new Float32Array(count);

    for (let index = 0; index < count; index += 1) {
        positions[index * 3] = (Math.random() - 0.5) * 14;
        positions[index * 3 + 1] = (Math.random() - 0.5) * 14;
        positions[index * 3 + 2] = (Math.random() - 0.5) * 8;
        const heat = Math.random();
        colors[index * 3] = 1;
        colors[index * 3 + 1] = 0.18 + heat * 0.62;
        colors[index * 3 + 2] = 0.04 + heat * 0.08;
        sizes[index] = 8 + Math.random() * 22;
        speeds[index] = 0.35 + Math.random() * 1.15;
        phases[index] = Math.random() * Math.PI * 2;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    geometry.setAttribute('aSpeed', new THREE.BufferAttribute(speeds, 1));
    geometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));

    const material = new THREE.ShaderMaterial({
        uniforms: {
            uTime: { value: 0 },
            uTexture: { value: texture },
        },
        vertexShader: `
      attribute float aSize;
      attribute float aSpeed;
      attribute float aPhase;
      attribute vec3 color;
      uniform float uTime;
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        vColor = color;
        float y = mod(position.y + 7.0 + uTime * aSpeed, 14.0) - 7.0;
        vec3 pos = vec3(
          position.x + sin(uTime * 0.7 + aPhase) * 0.28,
          y,
          position.z + cos(uTime * 0.45 + aPhase) * 0.18
        );
        vec4 view = modelViewMatrix * vec4(pos, 1.0);
        gl_Position = projectionMatrix * view;
        float twinkle = 0.65 + 0.35 * sin(uTime * 4.0 + aPhase);
        gl_PointSize = aSize * twinkle * (7.0 / -view.z);
        vAlpha = smoothstep(-7.0, -4.5, y) * smoothstep(7.0, 4.2, y);
      }
    `,
        fragmentShader: `
      uniform sampler2D uTexture;
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        vec4 tex = texture2D(uTexture, gl_PointCoord);
        if (tex.a < 0.03) discard;
        gl_FragColor = vec4(vColor * tex.rgb, tex.a * vAlpha);
      }
    `,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
    });

    return { points: new THREE.Points(geometry, material), material };
}

function emberTexture() {
    const sprite = document.createElement('canvas');
    sprite.width = 64;
    sprite.height = 64;
    const context = sprite.getContext('2d');
    const gradient = context.createRadialGradient(32, 32, 0, 32, 32, 32);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.18, 'rgba(255,214,120,0.95)');
    gradient.addColorStop(0.42, 'rgba(255,90,20,0.45)');
    gradient.addColorStop(1, 'rgba(255,40,0,0)');
    context.fillStyle = gradient;
    context.fillRect(0, 0, 64, 64);
    const texture = new THREE.CanvasTexture(sprite);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
}
