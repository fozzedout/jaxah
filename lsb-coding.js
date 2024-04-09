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

function decodeText() {
  var img = document.getElementById("image");
  var canvas = document.createElement("canvas");
  var ctx = canvas.getContext("2d", { willReadFrequently: true });
  canvas.width = img.width;
  canvas.height = img.height;
  ctx.drawImage(img, 0, 0);

  var y = 0;
  var decodedText = "";
  var decoder = new TextDecoder("utf-8");

  while (y < img.height) {
    var binaryText = [];
    var x = 0;

    while (x < img.width) {
      var byte = 0;

      for (var j = 7; j >= 0; j--) {
        var pixel = ctx.getImageData(x, y, 1, 1);
        var bit = pixel.data[0] & 1;
        byte = (byte << 1) | bit;
        x++;
      }

      if (byte === 0) break; // Check for null byte
      binaryText.push(byte);
    }

    var decodedLine = decoder.decode(Uint8Array.from(binaryText));
    if (decodedLine === "END") break;

    decodedText += decodedLine + "\n";
    y++;
  }

  document.getElementById("text").value = decodedText; // Set the decoded text

  console.log("Decoded Text");
  return decodedText;
}

function generateRandomPassword(length) {
  const characters = Array.from({ length: length }, () => {
    const randomNumber = Math.floor(Math.random() * (0x10ffff - 0x20) + 0x20);
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
    if (i % 2 === 0) {
      // Even index, add a consonant
      password += consonants[Math.floor(Math.random() * consonants.length)];
    } else {
      // Odd index, add a vowel
      const randomIndex = Math.floor(Math.random() * vowels.length);
      password += vowels[randomIndex];
    }

    // Add number & symbol
    if (i > 0 && i % 6 === 0) {
      if (Math.random() < 0.5) {
        // 50% chance of adding a symbol first
        password += symbols[Math.floor(Math.random() * symbols.length)];
        password += Math.floor(Math.random() * 10);
      } else {
        // 50% chance of adding a number first
        password += Math.floor(Math.random() * 10);
        password += symbols[Math.floor(Math.random() * symbols.length)];
      }
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

/**
 * Generates unique coordinates without repetition using a fixed seed.
 * @param {number} numCoordinates - The number of coordinates to generate.
 * @param {number} ignoreX - The x-coordinate to ignore.
 * @param {number} ignoreY - The y-coordinate to ignore.
 * @param {number} maxX - The maximum value for x-coordinate.
 * @param {number} maxY - The maximum value for y-coordinate.
 * @param {number} maxZ - The maximum value for z-coordinate.
 * @param {Function} random - A seeded random number generator function.
 * @returns {number[][]} - An array of unique coordinates represented as [x, y, z].
 */
function generateUniqueCoordinatesWithSeed(
  numCoordinates,
  ignoreX,
  ignoreY,
  maxX,
  maxY,
  maxZ,
  random
) {
  /**
   * Set to store generated coordinates.
   * @type {Set<string>}
   */
  const coordinates = new Set();

  // Loop until desired number of unique coordinates are generated
  while (coordinates.size < numCoordinates) {
    // Generate random coordinates within specified bounds
    const x = Math.floor(random() * (maxX + 1));
    const y = Math.floor(random() * (maxY + 1));
    const z = Math.floor(random() * (maxZ + 1));

    // Ignore coordinates that match ignoreX and ignoreY
    if (x === ignoreX && y === ignoreY) continue;

    // Add unique coordinate to the set
    coordinates.add(`${x},${y},${z}`);
  }

  // Convert set of coordinates to array and parse each coordinate to number
  return Array.from(coordinates).map((coord) => coord.split(",").map(Number));
}

function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}

/**
 * Generates unique coordinates without repetition using a fixed seed.
 * @param {number} numCoordinates - The number of coordinates to generate.
 * @param {number} ignoreX - The x-coordinate to ignore.
 * @param {number} ignoreY - The y-coordinate to ignore.
 * @param {number} maxX - The maximum value for x-coordinate.
 * @param {number} maxY - The maximum value for y-coordinate.
 * @param {number} maxZ - The maximum value for z-coordinate.
 * @param {Function} random - A seeded random number generator function.
 * @returns {number[][]} - An array of unique coordinates represented as [x, y, z].
 */
function generateUniqueCoordinatesWithSeedWeak(
  numCoordinates,
  ignoreX,
  ignoreY,
  maxX,
  maxY,
  random
) {
  const coordinates = new Set();

  /**
   * Array to store unique coordinates.
   * @type {number[][]}
   */
  const uniqueCoordinates = [];

  if (numCoordinates > (maxX + 1) * (maxY + 1) * 3) {
    console.log(
      "Not enough space. Requested:",
      numCoordinates,
      "    Available:",
      maxX * maxY * 3
    );
    return false;
  }

  var ix = -1;
  var iy = -1;
  var x = 0;
  var y = 0;
  // Loop until desired number of unique coordinates are generated
  while (uniqueCoordinates.length < numCoordinates) {
    if (uniqueCoordinates.length < maxX * maxY * 1.5) {
      // Generate random coordinates within specified bounds
      x = Math.floor(random() * (maxX + 1));
      y = Math.floor(random() * (maxY + 1));
    } else {
      // 50% of space is taken randomly, fill in the
      // remainder space linearly
      ix++;
      if (ix > maxX || iy === -1) {
        ix = 0;
        iy++;

        if (iy > maxY) {
          console.log("exceeded image space");
          return false;
        }
      }
      x = ix;
      y = iy;
    }

    // Ignore coordinates that match ignoreX and ignoreY
    if (x === ignoreX && y === ignoreY) continue;

    // Check if the coordinate is already in the set
    //const coordinate = [x, y, z];
    const coordinate = x * maxX + y;
    if (coordinates.has(coordinate)) continue;

    // Add unique coordinate to the set and array
    coordinates.add(coordinate);
    uniqueCoordinates.push([x, y, 0]);

    if (uniqueCoordinates.length < numCoordinates)
      uniqueCoordinates.push([x, y, 1]);

    if (uniqueCoordinates.length < numCoordinates)
      uniqueCoordinates.push([x, y, 2]);
  }

  return uniqueCoordinates;
}

/**
 * Generates unique coordinates
 * @param {number} numCoordinates - The number of coordinates to generate.
 * @param {number} maxX - The maximum value for x-coordinate.
 * @param {number} maxY - The maximum value for y-coordinate.
 * @returns {number[][]} - An array of unique coordinates represented as [x, y, z].
 */
function generateUniqueCoordinates(numCoordinates, maxX, maxY) {
  if (numCoordinates > (maxX + 1) * (maxY + 1) * 3) {
    console.log(
      "Not enough space. Requested:",
      numCoordinates,
      "    Available:",
      maxX * maxY * 3
    );
    return false;
  }

  /**
   * Array to store unique coordinates.
   * @type {number[][]}
   */
  const uniqueCoordinates = [];

  var x = 0;
  var y = 0;
  // Loop until desired number of unique coordinates are generated
  while (uniqueCoordinates.length < numCoordinates) {
    x++;
    if (x > maxX || y === -1) {
      ix = 0;
      iy++;

      if (iy > maxY) {
        console.log("exceeded image space");
        return false;
      }
    }

    // Add unique coordinate to the set and array
    coordinates.add(coordinate);
    uniqueCoordinates.push([x, y, 0]);

    if (uniqueCoordinates.length < numCoordinates)
      uniqueCoordinates.push([x, y, 1]);

    if (uniqueCoordinates.length < numCoordinates)
      uniqueCoordinates.push([x, y, 2]);
  }

  return uniqueCoordinates;
}

function scatterPoints(maxX, maxY, maxZ, length, ignoreX, ignoreY, random) {
  // guard against too much allocation (length + ignore pixel)
  if ((maxX+1) * (maxY+1) * (maxZ+1) < length+3) {
    console.log("Not enougn space in image. Has ", (maxX+1) * (maxY+1) * (maxZ+1), "   needs ", length+3);
    return false;
  }

  // Generate a list of all possible points within the specified ranges
  let allPoints = [];
  for (let x = 0; x <= maxX; x++) {
    for (let y = 0; y <= maxY; y++) {
      if (!(x === ignoreX && y === ignoreY)) {
        for (let z = 0; z <= maxZ; z++) {
          allPoints.push({ x: x, y: y, z: z });
        }
      }
    }
  }

  // Shuffle the list of points
  for (let i = allPoints.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [allPoints[i], allPoints[j]] = [allPoints[j], allPoints[i]];
  }

  // Truncate the list to the specified length
  const truncatedPoints = allPoints.slice(0, length);
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
  const random = new rand(
    seed.data[0],
    seed.data[1],
    seed.data[2],
    seed.data[3]
  );

  // Allow randomness to settle in by calling random function multiple times
  random();
  random();
  random();
  random();

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
      var pixel = ctx.getImageData(uc[idx][0], uc[idx][1], 1, 1);
      pixel.data[uc[idx][2]] = (pixel.data[uc[idx][2]] & 0xfe) | bit;
      ctx.putImageData(pixel, uc[idx][0], uc[idx][1]);
      idx++;
    }
  }

  // Get the encoded image data URL
  var encodedImage = canvas.toDataURL();

  // Update the original image with the encoded image
  img.src = encodedImage;

  // Display message in the console
  console.log("Encoded Text");
}

/**
 * Decodes text from an image using a seeded random process.
 * @returns {string} - The decoded text.
 */
function decodeRandom() {
  /**
   * Reference to the image element.
   * @type {HTMLImageElement}
   */
  var img = document.getElementById("image");

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

  // Set canvas dimensions to match image dimensions
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;

  // Draw the image onto the canvas
  ctx.drawImage(img, 0, 0);

  // Calculate center coordinates to ignore for decoding
  const ignoreX = Math.floor(canvas.width / 2);
  const ignoreY = Math.floor(canvas.height / 2);

  // Get pixel data at ignoreX, ignoreY for seed generation
  var seed = ctx.getImageData(ignoreX, ignoreY, 1, 1);

  // Initialize a seeded random number generator
  var random = new rand(seed.data[0], seed.data[1], seed.data[2], seed.data[3]);

  // Allow randomness to settle in by calling random function multiple times
  random();
  random();
  random();
  random();

  // Fetch the data length
  const ucLength = generateUniqueCoordinatesWithSeedWeak(
    32,
    ignoreX,
    ignoreY,
    canvas.width - 1,
    canvas.height - 1,
    random
  );
  if (uc === false) return;

  // Extract length information from pixel data
  var lengthArray = new Uint8Array(4);
  var bitpos = 0;
  var byte = 0;
  var pos = 0;
  for (var idx = 0; idx < 32; idx++) {
    var pixel = ctx.getImageData(ucLength[idx][0], ucLength[idx][1], 1, 1);
    var bit = pixel.data[ucLength[idx][2]] & 1;
    byte = (byte << 1) | bit;
    bitpos++;
    if (bitpos == 8) {
      lengthArray[pos] = byte;
      bitpos = 0;
      byte = 0;
      pos++;
    }
  }

  // Calculate the length of the encoded data
  var length =
    (lengthArray[0] << 24) |
    (lengthArray[1] << 16) |
    (lengthArray[2] << 8) |
    lengthArray[3];

  // Reset the seed for data decoding
  var random = new rand(seed.data[0], seed.data[1], seed.data[2], seed.data[3]);
  random();
  random();
  random();
  random(); // allow randomness to settle in

  // Regenerate unique coordinates including the length to avoid collisions
  const uc = generateUniqueCoordinatesWithSeed(
    32 + length * 8,
    ignoreX,
    ignoreY,
    canvas.width - 1,
    canvas.height - 1,
    2,
    random
  );

  // Extract data section coordinates
  const ucData = uc.slice(32);

  // Decode binary text from image pixels
  var binaryText = new Uint8Array(length);
  bitpos = 0;
  pos = 0;
  byte = 0;

  for (var idx = 0; idx < length * 8; idx++) {
    if (idx % 10000 == 0) console.log("looping through ", idx);

    var pixel = ctx.getImageData(ucData[idx][0], ucData[idx][1], 1, 1);
    var bit = pixel.data[ucData[idx][2]] & 1;
    byte = (byte << 1) | bit;
    bitpos++;
    if (bitpos == 8) {
      binaryText[pos] = byte;
      bitpos = 0;
      byte = 0;
      pos++;
    }
  }

  // Decode UTF-8 encoded binary text
  var decoder = new TextDecoder("utf-8");
  var decodedText = decoder.decode(Uint8Array.from(binaryText));

  // Set the decoded text in the text input element
  document.getElementById("text").value = decodedText;

  // Display message in the console
  console.log("Decoded Text");
  return decodedText;
}


/**
 * Tests for scattering
 */
function scatterTest() {
  document.getElementById("lblProgress").innerText = "Scattering...";
  console.log("Scattering...");

  /**
   * Reference to the image element.
   * @type {HTMLImageElement}
   */
  var img = document.getElementById("image");

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
  fill_rate = img.naturalWidth * img.naturalHeight * 0.75;

  ignoreX = Math.floor(canvas.width / 2);
  ignoreY = Math.floor(canvas.height / 2);

  // Get pixel data at ignoreX, ignoreY for seed generation
  var seed = ctx.getImageData(ignoreX, ignoreY, 1, 1);

  // Reset the seed for data decoding
  var random = new rand(seed.data[0], seed.data[1], seed.data[2], seed.data[3]);
  random(); random(); random(); random(); // allow randomness to settle in

  var imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  var data = imageData.data;


  document.getElementById("lblProgress").innerText = "Generating...";
  console.log("Generating...");

   // Define scatterPoints as a Promise
   var scatterPromise = new Promise(function(resolve, reject) {
    resolve(scatterPoints(
      canvas.width - 1,
      canvas.height - 1,
      0,
      fill_rate,
      ignoreX,
      ignoreY,
      random
    ));
  });

  scatterPromise.then(function(uc) {
    if (uc === false) return;

    document.getElementById("lblProgress").innerText = "Generated";
    console.log("Generated");
    
  
    var i = 0;
    var processChunk = function() {
      for (var j = 0; j < 1000000 && i < uc.length; j++, i++) { // process 100 points per chunk
        var index = (uc[i].y * canvas.width + uc[i].x) * 4;
        data[index] = 0xff; // Red channel
        data[index + 1] = 0xff; // Green channel
        data[index + 2] = 0xff; // Blue channel
        data[index + 3] = 0xff; // Alpha channel
      }
  
      ctx.putImageData(imageData, 0, 0);
      if (i < uc.length) {
        document.getElementById("lblProgress").innerText = Math.floor(i / uc.length * 100).toString() ;
  
        requestAnimationFrame(processChunk); // continue processing next chunk
      } else {
        var encodedImage = canvas.toDataURL();
        img.src = encodedImage;
        document.getElementById("lblProgress").innerText = "...";
      }
    };
  
    processChunk();
  });

}



function previewImage(input) {
  if (input.files && input.files[0]) {
    var reader = new FileReader();

    reader.onload = function (e) {
      var image = document.getElementById("image");
      image.src = e.target.result;
      displayImageInfo(image);
    };

    reader.readAsDataURL(input.files[0]);
  }
}

function displayImageInfo(image) {
  const area = image.naturalWidth * image.naturalHeight - 1; // remove 1 pixel for the seed
  const spaceBits = area * 3 - 32; // remove 32 bits for the length of the data
  const spaceBytes = Math.floor(spaceBits / 8); // convert to bytes
  document.getElementById("lblSpace").innerText = "Data Space: " + spaceBytes;
}
