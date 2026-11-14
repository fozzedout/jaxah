function encodeText() {
  var img = document.getElementById("image");
  var canvas = document.createElement("canvas");
  var ctx = canvas.getContext("2d", { willReadFrequently: true });
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  ctx.drawImage(img, 0, 0);

  console.log(canvas.width, canvas.height);

  // Split the string into lines
  const lines = (document.getElementById("text").value + "\nEND").split("\n");

  var encoder = new TextEncoder();

  // Iterate through the lines by line number
  for (let y = 0; y < lines.length; y++) {
    var text = lines[y];
    //console.log(y, "  :  ", text);

    // Convert text to UTF-8 binary for comparison
    var binaryText = encoder.encode(text);

    // Append a null byte (00000000) to the end of the binary text
    binaryText = Uint8Array.from([...binaryText, 0x00]);

    var x = 0;

    for (var i = 0; i < binaryText.length; i++) {
      var byte = binaryText[i];

      for (var j = 7; j >= 0; j--) {
        var bit = (byte >> j) & 1;
        var pixel = ctx.getImageData(x, y, 1, 1);
        pixel.data[0] = (pixel.data[0] & 0xfe) | bit;
        ctx.putImageData(pixel, x, y);
        x++;
      }
    }
  }

  var encodedImage = canvas.toDataURL();
  img.src = encodedImage; // Update original image with encoded image

  console.log("Encoded Text");
}

async function decodeText() {
  if (!encodedFile && !currentFile) return;
  const { width: W, height: H, channels, pixels } = await parsePNG(encodedFile || currentFile);
  const decoder = new TextDecoder("utf-8");
  let y = 0, decodedText = "";

  while (y < H) {
    const lineBytes = [];
    let x = 0;
    while (x + 8 <= W) {
      let byte = 0;
      for (let j = 7; j >= 0; j--) byte = (byte << 1) | (pixels[(y*W+x++)*channels] & 1);
      if (byte === 0) break;
      lineBytes.push(byte);
    }
    const line = decoder.decode(Uint8Array.from(lineBytes));
    if (line === "END") break;
    decodedText += line + "\n";
    y++;
  }

  document.getElementById("text").value = decodedText;
  console.log("Decoded sequential text");
  return decodedText;
}

function cryptoInt(n) {
  const lim = Math.floor(0x100000000 / n) * n;
  const b = new Uint32Array(1);
  do { crypto.getRandomValues(b); } while (b[0] >= lim);
  return b[0] % n;
}

function generateRandomPassword(length) {
  const characters = Array.from({ length: length }, () => {
    const randomNumber = cryptoInt(0x10ffff - 0x20) + 0x20;
    return String.fromCharCode(randomNumber);
  });
  return characters.join("");
}

function generatePassword(length) {
  const vowels = ["a", "e", "i", "o", "u", "ai", "oo", "ee", "ea", "ou"];
  const consonants = "bcdfghjklmnpqrstvwxyzBCDFGHJKLMNPQRSTVWXYZ";
  const symbols = "!@#$%^&*()_+-=[]{}|;:,.<>?'~¦`¬£€\\/";
  let password = "";

  for (let i = 0; i < length; i++) {

    // Add number & symbol
    if (i > 0 && i % 7 === 0) {
      if (cryptoInt(2) === 0) {
        // 50% chance of adding a symbol first
        password += symbols[cryptoInt(symbols.length)];
        password += cryptoInt(10);
      } else {
        // 50% chance of adding a number first
        password += cryptoInt(10);
        password += symbols[cryptoInt(symbols.length)];
      }
    } else if (i % 2 === 0) {
      // Even index, add a consonant
      password += consonants[cryptoInt(consonants.length)];
    } else {
      // Odd index, add a vowel
      const randomIndex = cryptoInt(vowels.length);
      password += vowels[randomIndex];
    }

    if (i % 4 === 0) {
      password[i] = password[i].toUpperCase();
    }
  }

  return password;
}

/**
 * Generates a seeded random number generator function.
 * @param {number} a - Seed value for random number generation.
 * @param {number} b - Seed value for random number generation.
 * @param {number} c - Seed value for random number generation.
 * @param {number} d - Seed value for random number generation.
 * @returns {Function} - A function that generates a random number between 0 and 1 using the provided seeds.
 */
function rand(a, b, c, d) {
  /**
   * Generates a random number between 0 and 1.
   * @returns {number} - The generated random number.
   */
  return function () {
    // Ensure seeds are integers
    a |= 0;
    b |= 0;
    c |= 0;
    d |= 0;
    // Calculate intermediate value
    let t = (((a + b) | 0) + d) | 0;
    // Update seed d
    d = (d + 1) | 0;
    // Update seed a
    a = b ^ (b >>> 9);
    // Update seed b
    b = (c + (c << 3)) | 0;
    // Update seed c
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    // Return random number
    return (t >>> 0) / 4294967296;
  };
}

function fastRand(seed) {
    // Ensure seeds are integers
    seed |= 0;
  /**
   * Generates a random number between 0 and 1.
   * @returns {number} - The generated random number.
   */
  return function () {
    seed = seed ^ (seed << 15);
    seed = seed ^ (seed >> 17);
    seed = seed ^ (seed << 16);

    // Return random number as fraction between 0 and 1
    return (seed >>> 0) / 4294967296;
  };
}

// ---------------------- MS Lite 2024 Improved update,   [Now default PRIG() function in my game software]
// Miller Shuffle lite, 
// produces a shuffled Index given a base Index, a random seed and the length of the list being indexed
// for each inx: 0 to nlim-1, unique indexes are returned in a pseudo "random" order.
// 
// This variation of the Miller Shuffle algorithm is for when you need/want minimal coding and processing, 
// to acheive good randomness along with desirable shuffle characteristics & many millions of permutations.
// For a any shuffle this works really well; unlike using rand() which does not.  (used by DDesk_Shuffle)
function MillerShuffle_lite(inx, mixID, nlim) {
  var si, r1, r2, r3, rx;
  var p1=3343;
  var p2=9949, p3=9973;  // listSize must be smaller than these primes
  var randR;

  randR=mixID+131*Math.floor(inx/nlim);  // have inx overflow effect the mix
  si=(inx+randR)%nlim;   // cut the deck

  r1 = randR % p3;	// set of fixed randomizing values
  r2 = randR % p1;
  r3 = randR % p2;
  rx = Math.floor(randR/nlim) % nlim + 1;

  // perform conditional multi-faceted mathematical spin-mixing 
  if (si % 3 == 0) si = (((si / 3) * p1 + r1) % Math.floor((nlim + 2) / 3)) * 3; // spin-mix multiples of 3 
  if (si % 2 == 0) si = (((si / 2) * p2 + r2) % Math.floor((nlim + 1) / 2)) * 2; // spin-mix multiples of 2 
  if (si < rx) si = (si * p3 + r2) % rx;                       // mix random half one way
  else         si = ((si - rx) * p2 + r1) % (nlim - rx) + rx;  // and the other another
  si = (si * p3 + r3) % nlim;		// relatively prime gears churning operation
  
  return(si);  // return 'Shuffled' index
}


function ms_test() {
  console.log("starting ms_test()");
  console.time("ms shuffle");

  var si, r1, r2, r3, rx;
  var p1=3343;
  var p2=9949, p3=9973;  // listSize must be smaller than these primes
  var randR;
  var mixID=73259;
  var nlim=22875489;

  for(let inx = 0; inx < nlim; inx++) {

    randR=mixID+131*Math.floor(inx/nlim);  // have inx overflow effect the mix
    si=(inx+randR)%nlim;   // cut the deck
  
    r1 = randR % p3;	// set of fixed randomizing values
    r2 = randR % p1;
    r3 = randR % p2;
    rx = Math.floor(randR/nlim) % nlim + 1;
  
    // perform conditional multi-faceted mathematical spin-mixing 
    if (si % 3 == 0) si = (((si / 3) * p1 + r1) % Math.floor((nlim + 2) / 3)) * 3; // spin-mix multiples of 3 
    if (si % 2 == 0) si = (((si / 2) * p2 + r2) % Math.floor((nlim + 1) / 2)) * 2; // spin-mix multiples of 2 
    if (si < rx) si = (si * p3 + r2) % rx;                       // mix random half one way
    else         si = ((si - rx) * p2 + r1) % (nlim - rx) + rx;  // and the other another
    si = (si * p3 + r3) % nlim;		// relatively prime gears churning operation
    

  }
  console.timeEnd("ms shuffle");
  console.log("done");
}

function convertXYZtoIndex(x, y, z, width, height) {
  return x + (y * width) + (z * width * height);
}

function convertIndexToXYZ(index, width, height) {
  let z = Math.floor(index / (width * height));
  let r = index % (width * height);
  let y = Math.floor(r / height);
  let x = r % height;

  return {x: x, y: y, z: z};
}

function scatterPointsFast(maxX, maxY, maxZ, length, seed) {
  const width = maxX+1;
  const height = maxY+1;
  const wh = width*height;
  const whd = width*height * (maxZ+1);

  var nlim=whd+3; // total loength + ignore pixel

  // guard against too much allocation (length + ignore pixel)
  if (whd < length+3) {
    console.log("Not enougn space in image. Has ", whd, "   needs ", length+3);
    return false;
  }
  document.getElementById("lblProgress").innerText = "Generating points";

  console.log("Generating shuffled points");
  console.time("Generating points");
  var si, r1, r2, r3, rx;
  var p1=3343;
  var p2=9949, p3=9973;  // listSize must be smaller than these primes
  var randR;

  let allPoints = new Array(length);

  for(let inx = 0; inx < length; inx++) {

    randR=seed+131*Math.floor(inx/nlim);  // have inx overflow effect the mix
    si=(inx+randR)%nlim;   // cut the deck
  
    r1 = randR % p3;	// set of fixed randomizing values
    r2 = randR % p1;
    r3 = randR % p2;
    rx = Math.floor(randR/nlim) % nlim + 1;
  
    // perform conditional multi-faceted mathematical spin-mixing 
    if (si % 3 == 0) si = (((si / 3) * p1 + r1) % Math.floor((nlim + 2) / 3)) * 3; // spin-mix multiples of 3 
    if (si % 2 == 0) si = (((si / 2) * p2 + r2) % Math.floor((nlim + 1) / 2)) * 2; // spin-mix multiples of 2 
    if (si < rx) si = (si * p3 + r2) % rx;                       // mix random half one way
    else         si = ((si - rx) * p2 + r1) % (nlim - rx) + rx;  // and the other another
    si = (si * p3 + r3) % nlim;		// relatively prime gears churning operation
    
    let z = Math.floor(si / wh);
    let r = si % wh;
    let y = Math.floor(r / width);
    let x = r % width;
  
    allPoints[inx] = { x: x, y: y, z: z };
  }

  console.timeEnd("Generating points");
  console.log("Points: ", length);

  document.getElementById("lblProgress").innerText = "...";

  return allPoints;
}


function scatterPoints(maxX, maxY, maxZ, length, ignoreX, ignoreY, random) {
  // guard against too much allocation (length + ignore pixel)
  if ((maxX+1) * (maxY+1) * (maxZ+1) < length+3) {
    console.log("Not enougn space in image. Has ", (maxX+1) * (maxY+1) * (maxZ+1), "   needs ", length+3);
    return false;
  }
  document.getElementById("lblProgress").innerText = "Generating points";

  console.log("Generating points");

  // Generate a list of all possible points within the specified ranges
  console.time("Generating points");
  let maxSize = ((maxX+1) * (maxY+1) * (maxZ+1));
  let allPoints = new Array(maxSize-(maxZ+1)); // remove the ignore space
  let i = 0;
  for (let x = 0; x <= maxX; x++) {
    for (let y = 0; y <= maxY; y++) {
      if (!(x === ignoreX && y === ignoreY)) {
        for (let z = 0; z <= maxZ; z++) {
          allPoints[i] = { x: x, y: y, z: z };
          i++;
        }
      }
    }
  }

  document.getElementById("lblProgress").innerText = "Shuffling points";
  console.log("Shuffling points");

  // Shuffle the list of points
  for (let i = allPoints.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [allPoints[i], allPoints[j]] = [allPoints[j], allPoints[i]];
  }

  // Truncate the list to the specified length
  const truncatedPoints = allPoints.slice(0, length);
  console.log("Points: ", truncatedPoints.length);

  console.timeEnd("Generating points");
  document.getElementById("lblProgress").innerText = "...";

  return truncatedPoints;
}

/**
 * Encodes text into an image using a seeded random process.
 */
function encodeRandom() {
  /**
   * Reference to the image element.
   * @type {HTMLImageElement}
   */
  var img = document.getElementById("image");
  // The image this encode is produced from. toBlob below is async; if a new
  // image is loaded before it returns, its result belongs to the old image
  // and is discarded.
  const gen = imageGen;

  /**
   * A dynamically created canvas element.
   * @type {HTMLCanvasElement}
   */
  var canvas = document.createElement("canvas");

  /**
   * The 2D rendering context of the canvas.
   * @type {CanvasRenderingContext2D}
   */
  var ctx = canvas.getContext("2d", { willReadFrequently: true });

  // Set canvas dimensions to match image natural size
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;

  // Draw the image onto the canvas
  ctx.drawImage(img, 0, 0);

  // Calculate center coordinates to ignore for encoding
  const ignoreX = Math.floor(canvas.width / 2);
  const ignoreY = Math.floor(canvas.height / 2);

  // Get pixel data at ignoreX, ignoreY for seed generation
  var seed = ctx.getImageData(ignoreX, ignoreY, 1, 1);

  // Display canvas dimensions in the console
  console.log(canvas.width, canvas.height);

  // Get input text from HTML input element
  var text = document.getElementById("text").value;

  // Create a TextEncoder object for UTF-8 encoding
  var encoder = new TextEncoder();

  // Convert text to UTF-8 binary Uint8Array
  var binaryText = encoder.encode(text);

  // Create a Uint8Array to store the length and binary text
  var lengthArray = new Uint8Array(4); // 4 bytes for a 32-bit number
  lengthArray[0] = (binaryText.length >> 24) & 0xff;
  lengthArray[1] = (binaryText.length >> 16) & 0xff;
  lengthArray[2] = (binaryText.length >> 8) & 0xff;
  lengthArray[3] = binaryText.length & 0xff;

  // Concatenate lengthArray and binaryText
  var concatenatedArray = new Uint8Array(
    lengthArray.length + binaryText.length
  );
  concatenatedArray.set(lengthArray, 0); // Copy lengthArray to the beginning
  concatenatedArray.set(binaryText, lengthArray.length); // Copy binaryText after the length

  // Initialize a seeded random number generator
  const random = new fastRand((seed.data[0] << 24)+(seed.data[1] << 16)+(seed.data[2] << 8)+seed.data[3]);

  // Generate unique coordinates for encoding using seeded random generator
  const uc = scatterPoints(
    canvas.width - 1,
    canvas.height - 1,
    2,
    concatenatedArray.length * 8,
    ignoreX,
    ignoreY,
    random
  );
  if (uc === false) return;

  var idx = 0;
  for (var i = 0; i < concatenatedArray.length; i++) {
    var byte = concatenatedArray[i];

    for (var j = 7; j >= 0; j--) {
      var bit = (byte >> j) & 1;
      var pixel = ctx.getImageData(uc[idx].x, uc[idx].y, 1, 1);
      pixel.data[uc[idx].z] = (pixel.data[uc[idx].z] & 0xfe) | bit;
      ctx.putImageData(pixel, uc[idx].x, uc[idx].y);
      idx++;
    }
  }

  concatenatedArray = [];

  const stem = currentFilename.replace(/\.[^.]+$/, "");
  canvas.toBlob(blob => {
    if (gen !== imageGen) return; // a different image was loaded meanwhile: drop this stale result
    if (!blob) {
      document.getElementById("lblProgress").innerText = "Encode failed";
      return;
    }
    setEncoded(new File([blob], stem + "_enc.png", { type: 'image/png' }), gen);
    img.src = URL.createObjectURL(blob);
    document.getElementById("lblProgress").innerText = "Encoded (not scrambled)";
  }, 'image/png');

  // Display message in the console
  console.log("Encoded Text");
}

async function decodeRandom() {
  if (!encodedFile && !currentFile) return;
  const { width: W, height: H, channels, pixels } = await parsePNG(encodedFile || currentFile);

  const igX = Math.floor(W/2), igY = Math.floor(H/2);
  const si = (igY*W+igX)*channels;
  // Treat RGB images as alpha=255 to match what canvas returns for opaque images
  const alpha = channels >= 4 ? pixels[si+3] : 255;
  const seedNum = (pixels[si]<<24)+(pixels[si+1]<<16)+(pixels[si+2]<<8)+alpha;

  const getBit = (x,y,z) => pixels[(y*W+x)*channels+z] & 1;

  let rng = fastRand(seedNum);
  const ucLen = scatterPoints(W-1, H-1, 2, 32, igX, igY, rng);
  if (!ucLen) return;

  let byte=0, bitpos=0, pos=0;
  const lenBytes = new Uint8Array(4);
  for (let i=0; i<32; i++) {
    byte = (byte<<1) | getBit(ucLen[i].x, ucLen[i].y, ucLen[i].z);
    if (++bitpos===8) { lenBytes[pos++]=byte; bitpos=0; byte=0; }
  }

  const length = ((lenBytes[0]<<24)|(lenBytes[1]<<16)|(lenBytes[2]<<8)|lenBytes[3])>>>0;
  console.log("Decoded length:", length);
  if (length===0 || length>500_000) return;

  rng = fastRand(seedNum);
  const uc = scatterPoints(W-1, H-1, 2, 32+length*8, igX, igY, rng);
  if (!uc) return;

  const textBytes = new Uint8Array(length);
  byte=0; bitpos=0; pos=0;
  for (let i=32; i<uc.length; i++) {
    byte = (byte<<1) | getBit(uc[i].x, uc[i].y, uc[i].z);
    if (++bitpos===8) { textBytes[pos++]=byte; bitpos=0; byte=0; }
  }

  const text = new TextDecoder('utf-8').decode(textBytes);
  document.getElementById("text").value = text;
  console.log("Decoded random text:", text.length, "chars");
  return text;
}


/**
 * Tests for scattering
 */
function scatterTest() {
  //document.getElementById("lblProgress").innerText = "Scattering...";
  displayer = "Scattering...";
  requestAnimationFrame(myDisplayer);
  console.log("Scattering...");

  /**
   * Reference to the image element.
   * @type {HTMLImageElement}
   */
  var img = document.getElementById("image");

  if (img.currentSrc === "") {
    document.getElementById("lblProgress").innerText = "...";
    return;
  }

  /**
   * A dynamically created canvas element.
   * @type {HTMLCanvasElement}
   */
  var canvas = document.createElement("canvas");

  /**
   * The 2D rendering context of the canvas.
   * @type {CanvasRenderingContext2D}
   */
  var ctx = canvas.getContext("2d", { willReadFrequently: true });

  // Set canvas dimensions to match image natural size
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  
  // Draw the image onto the canvas
  ctx.drawImage(img, 0, 0);

  // fill test rate
  fill_rate = canvas.width * canvas.height * 0.5;

  ignoreX = Math.floor(canvas.width / 2);
  ignoreY = Math.floor(canvas.height / 2);

  // Get pixel data at ignoreX, ignoreY for seed generation
  var seed = ctx.getImageData(ignoreX, ignoreY, 1, 1);

  // Reset the seed for data decoding
  //var random = new rand(seed.data[0], seed.data[1], seed.data[2], seed.data[3]);
  //random(); random(); random(); random(); // allow randomness to settle in
  var random = new fastRand((seed.data[0] << 24)+(seed.data[1] << 16)+(seed.data[2] << 8)+seed.data[3]);

  var imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  var data = imageData.data;


  //document.getElementById("lblProgress").innerText = "Generating...";
  displayer = "Generating...";
  requestAnimationFrame(myDisplayer);

  console.log("Generating...");

   // Define scatterPoints as a Promise
   var sp = scatterPoints(
      canvas.width - 1,
      canvas.height - 1,
      0,
      fill_rate,
      ignoreX,
      ignoreY,
      random
    );

    if (sp === false) return;

    //document.getElementById("lblProgress").innerText = "Generated";
    displayer = "Generated";
    requestAnimationFrame(myDisplayer);
    console.log("Generated");
  
    var i = 0;
    var processChunk = function() {
      for (var j = 0; j < 1000000 && i < sp.length; j++, i++) { // process 100 points per chunk
        var index = (sp[i].y * canvas.width + sp[i].x) * 4;
        data[index] = 0xff; // Red channel
        data[index + 1] = 0xff; // Green channel
        data[index + 2] = 0xff; // Blue channel
        data[index + 3] = 0xff; // Alpha channel
      }
  
      ctx.putImageData(imageData, 0, 0);
      if (i < sp.length) {
        document.getElementById("lblProgress").innerText = Math.floor(i / sp.length * 100).toString() ;
        requestAnimationFrame(processChunk); // continue processing next chunk
      } else {
        img.src = canvas.toDataURL();
        document.getElementById("lblProgress").innerText = "...";
      }
    };
  
    processChunk();

  //document.getElementById("lblProgress").innerText = "...";
  displayer = "...";
  requestAnimationFrame(myDisplayer);

}



/**
 * Tests for scattering
 */
function scatterTestFast() {
  //document.getElementById("lblProgress").innerText = "Scattering...";
  displayer = "Scattering...";
  requestAnimationFrame(myDisplayer);
  console.log("Scattering...");

  /**
   * Reference to the image element.
   * @type {HTMLImageElement}
   */
  var img = document.getElementById("image");

  if (img.currentSrc === "") {
    document.getElementById("lblProgress").innerText = "...";
    return;
  }

  /**
   * A dynamically created canvas element.
   * @type {HTMLCanvasElement}
   */
  var canvas = document.createElement("canvas");

  /**
   * The 2D rendering context of the canvas.
   * @type {CanvasRenderingContext2D}
   */
  var ctx = canvas.getContext("2d", { willReadFrequently: true });

  // Set canvas dimensions to match image natural size
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  
  // Draw the image onto the canvas
  ctx.drawImage(img, 0, 0);

  // fill test rate
  fill_rate = canvas.width * canvas.height * 0.5;

  // Get pixel data at ignoreX, ignoreY for seed generation
  seedX = Math.floor(canvas.width / 2);
  seedY = Math.floor(canvas.height / 2);
  var seed = ctx.getImageData(seedX, seedY, 1, 1);
  var seedNum = ((seed.data[0] & 0xfe) << 16) + ((seed.data[1] & 0xfe) << 8) + (seed.data[2] & 0xfe);

  var imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  var data = imageData.data;


  //document.getElementById("lblProgress").innerText = "Generating...";
  displayer = "Generating...";
  requestAnimationFrame(myDisplayer);

  console.log("Generating...");

   // Define scatterPoints as a Promise
   var sp = scatterPointsFast(
      canvas.width - 1,
      canvas.height - 1,
      0,
      fill_rate,
      seedNum
    );

    if (sp === false) return;

    //document.getElementById("lblProgress").innerText = "Generated";
    displayer = "Generated";
    requestAnimationFrame(myDisplayer);
    console.log("Generated");
  
    var i = 0;
    var processChunk = function() {
      for (var j = 0; j < 1000000 && i < sp.length; j++, i++) { // process 100 points per chunk
        var index = (sp[i].y * canvas.width + sp[i].x) * 4;
        data[index] = 0xff; // Red channel
        data[index + 1] = 0xff; // Green channel
        data[index + 2] = 0xff; // Blue channel
        data[index + 3] = 0xff; // Alpha channel
      }
  
      ctx.putImageData(imageData, 0, 0);
      if (i < sp.length) {
        document.getElementById("lblProgress").innerText = Math.floor(i / sp.length * 100).toString() ;
        requestAnimationFrame(processChunk); // continue processing next chunk
      } else {
        img.src = canvas.toDataURL();
        document.getElementById("lblProgress").innerText = "...";
      }
    };
  
    processChunk();

  //document.getElementById("lblProgress").innerText = "...";
  displayer = "...";
  requestAnimationFrame(myDisplayer);

}



let displayer = "...";
function myDisplayer() {
  document.getElementById("lblProgress").innerHTML = displayer;
}


let currentFilename = "";
let currentFile = null; // original raw File object
let encodedFile = null;
// Generation of the currently loaded image. Bumped on every load; an encode
// captures it at start and its result is kept only if it still matches.
let imageGen = 0;
let encodedGen = -1; // generation encodedFile was produced from

function setEncoded(file, gen) {
  if (gen !== imageGen) return false;
  encodedFile = file;
  encodedGen = gen;
  return true;
}

function previewImage(input) {
  if (input.files && input.files[0]) {
    const gen = ++imageGen;
    currentFile = input.files[0];
    encodedFile = null;
    encodedGen = -1;
    currentFilename = currentFile.name;
    const reader = new FileReader();
    reader.onload = function(e) {
      if (gen !== imageGen) return; // a later load superseded this one
      const image = document.getElementById("image");
      image.src = e.target.result;
      displayImageInfo(image);
    };
    reader.readAsDataURL(currentFile);
  }
}

function displayImageInfo(image) {
  const area = image.naturalWidth * image.naturalHeight - 1; // remove 1 pixel for the seed
  const spaceBits = area * 3 - 32; // remove 32 bits for the length of the data
  const spaceBytes = Math.floor(spaceBits / 8); // convert to bytes
  document.getElementById("lblSpace").innerText = "Data Space: " + spaceBytes;
}

// Encode with random placement then fill every unused R/G/B LSB with
// cryptographically random bits. Operates directly on PNG bytes — no canvas,
// immune to Brave/Firefox anti-fingerprinting noise.
async function encodeAndScramble() {
  if (!currentFile) {
    document.getElementById("lblProgress").innerText = "Load an image first";
    return;
  }
  const gen = imageGen;
  const srcFile = currentFile;
  const srcName = currentFilename;

  let png;
  try {
    png = await parsePNG(srcFile);
  } catch (e) {
    document.getElementById("lblProgress").innerText = "Error: " + e.message;
    return;
  }

  const { width: W, height: H, channels, colorType, pixels: d } = png;
  const igX = Math.floor(W/2), igY = Math.floor(H/2);

  const si = (igY*W+igX)*channels;
  const alpha = channels >= 4 ? d[si+3] : 255; // RGB images treated as opaque
  const seed = (d[si]<<24)+(d[si+1]<<16)+(d[si+2]<<8)+alpha;

  const text = document.getElementById("text").value;
  const encoded = new TextEncoder().encode(text);
  const payload = new Uint8Array(4 + encoded.length);
  payload[0]=(encoded.length>>24)&0xff; payload[1]=(encoded.length>>16)&0xff;
  payload[2]=(encoded.length>>8) &0xff; payload[3]= encoded.length      &0xff;
  payload.set(encoded, 4);

  const rng = new fastRand(seed);
  const uc = scatterPoints(W-1, H-1, 2, payload.length*8, igX, igY, rng);
  if (uc === false) {
    document.getElementById("lblProgress").innerText = "Image too small for this text";
    return;
  }

  // Write payload bits directly into pixel array
  for (let i=0, bi=0; i<payload.length; i++) {
    for (let j=7; j>=0; j--, bi++) {
      const p=uc[bi], fi=(p.y*W+p.x)*channels+p.z;
      d[fi] = (d[fi]&0xfe)|((payload[i]>>j)&1);
    }
  }

  // Scramble all unused R/G/B LSBs with crypto-random noise
  const used = new Set(uc.map(p => (p.y*W+p.x)*channels+p.z));
  const noise = new Uint8Array(W*H);
  for (let o=0; o<noise.length; o+=65536) {
    crypto.getRandomValues(noise.subarray(o, Math.min(o+65536, noise.length)));
  }
  for (let y=0,ni=0; y<H; y++) {
    for (let x=0; x<W; x++,ni++) {
      if (x===igX && y===igY) continue; // preserve seed pixel
      for (let z=0; z<3; z++) {
        const fi=(y*W+x)*channels+z;
        if (!used.has(fi)) d[fi]=(d[fi]&0xfe)|((noise[ni]>>z)&1);
      }
    }
  }

  const pngBytes = await encodePNG(W, H, channels, colorType, d);
  if (gen !== imageGen) return; // a different image was loaded during the encode: drop it
  const blob = new Blob([pngBytes], { type: 'image/png' });

  const stem = srcName.replace(/\.[^.]+$/, "");
  setEncoded(new File([blob], stem + "_enc.png", { type: 'image/png' }), gen);

  const img = document.getElementById("image");
  img.src = URL.createObjectURL(blob);
  displayImageInfo(img);
  document.getElementById("lblProgress").innerText = "Encoded + scrambled";
  console.log("Encoded and scrambled:", text.length, "chars");
}

function downloadCurrent() {
  if (!encodedFile || encodedGen !== imageGen) {
    document.getElementById("lblProgress").innerText = "Encode first — nothing encoded to download";
    return;
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(encodedFile);
  a.download = encodedFile.name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}
