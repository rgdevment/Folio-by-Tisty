import type { Document } from "@tisty/contracts";

// Only to see the frame while building it. A real document comes from its envelope, and the build leaves this out.
export const SAMPLE: Document = {
  id: "k7Qm2xPa",
  title: "Entorno local con Docker y WSL2, paso a paso",
  tags: ["guia", "docker"],
  lang: "es",
  signed_as: "Camila",
  made: "2026-10-07T14:00:00Z",
  wrote: "2026-11-02T09:30:00Z",
  body: "",
  html: [
    '<dl class="front"><dt>title</dt><dd>Entorno local con Docker y WSL2, paso a paso</dd><dt>fuente</dt><dd>Apuntes propios</dd></dl>',
    '<h1 id="entorno">Entorno local con Docker y WSL2, paso a paso</h1>',
    "<p>Esta guía junta lo que fui aprendiendo al armar mi entorno en Windows. Sirve tanto si empiezas de cero como si ya tienes WSL instalado y algo no funciona.</p>",
    '<h2 id="antes">Antes de empezar</h2>',
    "<ul><li>Windows 11 actualizado</li><li>Virtualización activa en la BIOS</li><li>Al menos 16 GB de RAM para trabajar cómodo</li></ul>",
    '<h2 id="instalar">Instalar WSL</h2>',
    "<p>Abre una terminal como administrador y ejecuta:</p>",
    '<figure class="code"><pre><code class="language-bash">wsl --install -d Ubuntu\nwsl --set-default-version 2</code></pre></figure>',
    "<blockquote><p><strong>Ojo:</strong> si la instalación se queda en 0 %, reinicia y vuelve a correr el mismo comando. Es el error más común.</p></blockquote>",
    '<h2 id="errores">Errores típicos</h2>',
    '<div class="table"><table><thead><tr><th>Síntoma</th><th>Causa</th><th>Arreglo</th></tr></thead><tbody>',
    "<tr><td>Los volúmenes van lentos</td><td>El código vive en <code>/mnt/c</code></td><td>Muévelo a <code>/home</code></td></tr>",
    "<tr><td>Sin red dentro del contenedor</td><td>VPN corporativa</td><td>Modo de red <code>mirrored</code></td></tr>",
    "</tbody></table></div>",
    '<h3 id="mas">Si nada de eso resuelve</h3>',
    "<p>Revisa la versión de WSL con <code>wsl --version</code> y actualízala antes de seguir buscando.</p>",
  ].join(""),
};

export const SAMPLE_SEAL = {
  verdict: "holds",
  fingerprint: "48213 90175 22640 31987",
  ownerFingerprint: null,
  diesOn: "en 7 días",
} as const;
