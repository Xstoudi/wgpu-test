import imageUrl from './image.jpg'
import {readCanvas, Image as ImageJS, writeCanvas} from "image-js";

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;

async function loadImageFromCanvas () {
  return new Promise<void>((resolve) => {
    const img = new Image();
    img.onload = () => {
      canvas.width = img.width;
      canvas.height = img.height;
      ctx.drawImage(img, 0, 0);
      resolve();
    };
    img.src = imageUrl;
  })

}

await loadImageFromCanvas()

const image = await readCanvas(canvas)
const data = image.getRawImage().data;
console.log(data)

console.time('image-js')
image.invert()
console.timeEnd('image-js')


if (!navigator.gpu) throw Error("WebGPU not supported.");

const adapter = await navigator.gpu.requestAdapter();
if (!adapter) throw Error("Couldn’t request WebGPU adapter.");

const device = await adapter.requestDevice();
if (!device) throw Error("Couldn’t request WebGPU logical device.");


const module = device.createShaderModule({
  code: `
    @group(0) @binding(0)
    var<storage, read> input: array<u32>;
    
    @group(0) @binding(1)
    var<storage, read_write> output: array<u32>;
    
    @compute @workgroup_size(256)
    fn main(
    
      @builtin(global_invocation_id)
      global_id : vec3<u32>,
    
      @builtin(local_invocation_id)
      local_id : vec3<u32>,
    
    ) {
      output[global_id.x] = (input[global_id.x] ^ 0xffffffffu) | 0xff000000u;
    }
  `,
});

const bindGroupLayout =
  device.createBindGroupLayout({
    entries: [{
      binding: 0,
      visibility: GPUShaderStage.COMPUTE,
      buffer: {
        type: "read-only-storage",
      },
    },{
      binding: 1,
      visibility: GPUShaderStage.COMPUTE,
      buffer: {
        type: "storage",
      },
    }],
  });

const input = device.createBuffer({
  size: data.byteLength,
  usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
});

const output = device.createBuffer({
  size: data.byteLength,
  usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
});

const stagingBuffer = device.createBuffer({
  size: data.byteLength,
  usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
});

const bindGroup = device.createBindGroup({
  layout: bindGroupLayout,
  entries: [{
    binding: 0,
    resource: {
      buffer: input,
    }
  }, {
    binding: 1,
    resource: {
      buffer: output,
    },
  }],
});

const pipeline = device.createComputePipeline({
  compute: {
    module,
    entryPoint: "main"
  },
  layout: device.createPipelineLayout({
    bindGroupLayouts: [bindGroupLayout],
  }),
});

console.time('webgpu')

const increment = 65535 * 256
async function gpu(data, offset) {
  const commandEncoder = device.createCommandEncoder();
  const passEncoder = commandEncoder.beginComputePass();
  passEncoder.setPipeline(pipeline);
  passEncoder.setBindGroup(0, bindGroup);
  passEncoder.dispatchWorkgroups(65535);
  passEncoder.end();

  commandEncoder.copyBufferToBuffer(
    output,
    0,
    stagingBuffer,
    0,
    data.byteLength
  )
  const commands = commandEncoder.finish();
  device.queue.writeBuffer(input, 0, data);
  device.queue.submit([commands]);

  await stagingBuffer.mapAsync(
    GPUMapMode.READ,
    0,
    data.byteLength
  );

  const copyArrayBuffer = stagingBuffer.getMappedRange(0, data.byteLength);

  const newdata = new Uint8Array(copyArrayBuffer.slice(0))
  stagingBuffer.unmap()

  return newdata
}

const newdata = new Uint8Array(data.length)
for(let i = 0; i < data.length; i += increment) {
  let clamped = i + increment > data.length ? data.length : i + increment
  const partial = await gpu(data.slice(i, clamped), i)
  newdata.set(partial, i)
}


console.timeEnd('webgpu')

const newImage = new ImageJS(image.width, image.height, {data: newdata, colorModel: image.colorModel, bitDepth: image.bitDepth})

const canvas2 = document.getElementById("canvas2") as HTMLCanvasElement;

writeCanvas(newImage, canvas2, {resizeCanvas: true})
