# Política de seguridad de Folio by Tisty

[English](SECURITY.md)

Cubre el servicio Folio: sus links en tisty.cl, su API bajo
`/api/v1/`, la página que lee un link y el formato del sobre que hablan la app y
el servidor. La app Tisty tiene su propia [política de seguridad](https://github.com/rgdevment/Tisty/blob/main/SECURITY.md).

## Reportar una vulnerabilidad

**No abras un issue público.** Usa uno de estos canales privados:

- **Correo** <rgdevment@tisty.app>, con asunto `[SECURITY][Folio] descripción corta`.
- **GitHub Security Advisory**: la pestaña *Security*, *Report a vulnerability*.

Sirve que el reporte diga qué podría hacer un atacante y a quién, y los pasos
para reproducirlo. Prueba solo con links que tú creaste, nunca con documentos
de otras personas, y nunca con carga pensada para botar el servicio.

Recibirás una respuesta en 48 horas. La investigación de buena fe nunca recibirá
amenazas legales.

## Qué protege el diseño

- **Lo compartido sigue ilegible para el servicio.** Cada parte del documento se
  sella en el Tisty de quien comparte con AES-256-GCM, con una llave que
  viaja después del `#` del link y nunca llega al servidor. Un compromiso en el
  sobre lo ata a esa sola llave.
- **El servidor solo lee el manifiesto:** cuántas partes hay, de qué tipo y
  tamaño, y la versión. Aplica todos los topes sin la llave.
- **Se puede saber quién lo firmó.** Cada equipo tiene su propia llave,
  certificada por la llave raíz de la persona. Una sola firma cubre el manifiesto
  y el hash de cada parte, así que responde por todo lo de adentro, y el servidor
  rechaza una subida sin ella. Dice quién firmó, no qué programa lo hizo. Las
  llaves retiradas se le avisan a cada lector.
- **La hoja nunca se cree.** La página de lectura limpia la hoja con una lista
  cerrada de etiquetas y estilos, no corre ningún script que venga en ella, y
  vive detrás de una política de seguridad de contenido que no permite nada de
  otro origen.
- **Las imágenes salen limpias.** Se vuelven a escribir o, en una foto que no
  necesita cambios, se dejan solo la imagen y su perfil de color: sin
  ubicación, sin comentarios, sin nada escondido detrás.
- **Abusar cuesta.** Denunciar y compartir algo nuevo piden una prueba de
  trabajo, y también un lector nuevo pasado el cupo gratis del día. Iniciar un
  compartido y leer tienen un freno de velocidad por red, y subir tiene un cupo
  por red y una espera por persona.

## Qué no protege

- **La página que descifra la sirve el mismo servidor.** Eso protege ante una
  filtración o una orden sobre lo guardado, pero no ante un operador que
  decidiera cambiar ese código para robar llaves. El código es público para que
  cualquiera lo revise, y cada versión publica una lista atestada del código de
  la página, para compararla con lo que se sirve, que se comprueba con
  `gh attestation verify SHA256SUMS --repo rgdevment/Folio-by-Tisty`; entre dos
  apps Tisty esto no aplica.
- **Quien tiene un link lo lee,** y puede pasarlo. Un link no se puede retirar
  salvo dejando de compartir.
- **Lo que el servicio ve igual:** tamaños, horas, el id del link y, por unos
  días, el país y el centro de datos de Cloudflare de cada lectura. Cloudflare
  ve la IP de quien lee, como cualquier hosting.
- **Una denuncia que trae el link para leerlo** hace legible ese documento, en los
  casos que dicen los [términos](TERMINOS.md).

## Versiones con soporte

Solo lo que corre hoy en tisty.cl, el último tag `v*`. Los sobres se leen
solo en su formato actual.
