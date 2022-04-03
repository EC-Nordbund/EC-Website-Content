import { readdirSync, statSync, readFileSync, writeFileSync } from "fs";
import { join } from "path/posix";
import { ImagePool } from "@squoosh/lib";
import { cpus } from "os";

const imagePool = new ImagePool(cpus().length);

const normalScalars = [1.5, 2, 3, 5, 6, 8, 10];

const extra = {
  'png': {
    oxipng: { "level": 3, "interlace": false },
  },
  jpg: {
    mozjpeg: {
      "quality": 75,
      "baseline": false,
      "arithmetic": false,
      "progressive": true,
      "optimize_coding": true,
      "smoothing": 0,
      "color_space": 3,
      "quant_table": 3,
      "trellis_multipass": false,
      "trellis_opt_zero": false,
      "trellis_opt_table": false,
      "trellis_loops": 1,
      "auto_subsample": true,
      "chroma_subsample": 2,
      "separate_chroma_quality": false,
      "chroma_quality": 75,
    },
  }
}

export async function doImage(img, ext) {
  const ing = imagePool.ingestImage(img);
  // const ing2 = imagePool.ingestImage(img)

  const { width, height } = (await ing.decoded).bitmap;

  const scale = width > 2000 || height > 2000;

  if (scale) {
    const scaleBy =
      normalScalars.filter((v) => (width / v < 2000 && height / v < 2000))[0] ??
        Math.max(width, height) / 2000;

    await ing.preprocess({
      resize: {
        method: "lanczos3",
        width: Math.floor(width / scaleBy),
        height: Math.floor(height / scaleBy),
      },
    });
  }

  const result = await ing.encode({
    webp: {
      "quality": 50,
      "target_size": 0,
      "target_PSNR": 0,
      "method": 6,
      "sns_strength": 50,
      "filter_strength": 60,
      "filter_sharpness": 0,
      "filter_type": 1,
      "partitions": 0,
      "segments": 4,
      "pass": 1,
      "show_compressed": 0,
      "preprocessing": 0,
      "autofilter": 0,
      "partition_limit": 0,
      "alpha_compression": 1,
      "alpha_filtering": 1,
      "alpha_quality": 100,
      "lossless": 0,
      "exact": 0,
      "image_hint": 0,
      "emulate_jpeg_size": 0,
      "thread_level": 0,
      "low_memory": 0,
      "near_lossless": 100,
      "use_delta_palette": 0,
      "use_sharp_yuv": 0,
    },
    ...(extra[ext])    
  });

  if(ext === 'jpg') {
    return [result.webp.binary, result.mozjpeg.binary]
  } else {
    return [result.webp.binary, result.oxipng.binary]
  }
}

// imagePool.ingestImage()

// imagePool.


const imageExtensions = [
  'png',
  'jpg',
  'jpeg',
  'webp'
]

function walkFolder(folder) {
  const files = readdirSync(folder).map(v=>join(folder, v))
  
  const images = files.flatMap(v=>{
    if(statSync(v).isFile()) {
      if(imageExtensions.some(ext => v.endsWith('.' + ext))) {
        return [v]
      }

      return []
    }

    return walkFolder(v)
  })
  
  return images
}

export function toDo(folder) {
  const files = walkFolder(folder)

  const todo = files.filter(v=>{
    if(v.endsWith('.webp')) return false
    const parts = v.split('.')
    const webpPath = parts.slice(0, parts.length - 1).join('.') + '.webp'

    // console.log(v)
    // console.log(webpPath)
    // console.log(files.includes(webpPath))

    return !files.includes(webpPath)
  })

  return todo
}



async function run(folder) {
  const files = (await toDo(folder)).sort(()=>Math.random()-0.5).slice(1, 15)

  console.log(files.join('\n'))
  let c = 0


  files.forEach(async file => {
    const input = readFileSync(file)

    try {
      const [webp, other] = await doImage(input, file.endsWith('png') ? 'png' : 'jpg')

      writeFileSync(file, other)

      const parts = file.split('.')
      const webpPath = parts.slice(0, parts.length - 1).join('.') + '.webp'

      writeFileSync(webpPath, webp)
      c++

      console.log(file, 'done')
    } catch(ex) {
      c++
      console.log(file, 'error')
      console.log(ex)
    }

    if(c===files.length) {
      await imagePool.close()
      // process.exit()
    }
  });
}

run(process.cwd())
