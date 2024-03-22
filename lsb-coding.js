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
  const vowels = [
    "a",
    "e",
    "i",
    "o",
    "u",
    "ai",
    "oo",
    "ee",
    "ea",
    "ou"
  ];
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

// seeded random
function rand(a, b, c, d) {
  return function() {
    a |= 0; b |= 0; c |= 0; d |= 0;
    let t = (a + b | 0) + d | 0;
    d = d + 1 | 0;
    a = b ^ b >>> 9;
    b = c + (c << 3) | 0;
    c = (c << 21 | c >>> 11);
    c = c + t | 0;
    return (t >>> 0) / 4294967296;
  }
}

// Function to generate random coordinates without repetition using a fixed seed
function generateUniqueCoordinatesWithSeed(numCoordinates, ignoreX, ignoreY, maxX, maxY, maxZ, random) {
  const coordinates = new Set();
  while (coordinates.size < numCoordinates) {
      const x = Math.floor(random() * (maxX + 1));
      const y = Math.floor(random() * (maxY + 1));
      const z = Math.floor(random() * (maxZ + 1));

      // ignoreX & ignoreY cannot be touched
      if (x == ignoreX && y == ignoreY)
        continue;

      coordinates.add(`${x},${y},${z}`);
  }
  return Array.from(coordinates).map(coord => coord.split(',').map(Number));
}

function encodeRandom() {
  var img = document.getElementById("image");
  var canvas = document.createElement("canvas");
  var ctx = canvas.getContext("2d", { willReadFrequently: true });
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  ctx.drawImage(img, 0, 0);

  const ignoreX = canvas.width / 2;
  const ignoreY = canvas.height / 2;
  var seed = ctx.getImageData(ignoreX, ignoreY, 1, 1);

  console.log(canvas.width, canvas.height);

  var text = document.getElementById("text").value;
  var encoder = new TextEncoder();

  // Convert text to UTF-8 binary for comparison
  var binaryText = encoder.encode(text);

  // Create a new Uint8Array to store the length and binary text
  var lengthArray = new Uint8Array(4); // 4 bytes for a 32-bit number
  lengthArray[0] = binaryText.length >> 24 & 0xFF;
  lengthArray[1] = binaryText.length >> 16 & 0xFF;
  lengthArray[2] = binaryText.length >> 8 & 0xFF;
  lengthArray[3] = binaryText.length & 0xFF;

  // Concatenate lengthArray and binaryText
  var concatenatedArray = new Uint8Array(lengthArray.length + binaryText.length);
  concatenatedArray.set(lengthArray, 0); // Copy lengthArray to the beginning
  concatenatedArray.set(binaryText, lengthArray.length); // Copy binaryText after the length

  const random = new rand(seed.data[0],seed.data[1],seed.data[2],seed.data[3]);
  random();random();random();random(); // allow randomness to settle in

  const uc = generateUniqueCoordinatesWithSeed(concatenatedArray.length * 8, ignoreX, ignoreY, canvas.width-1, canvas.height-1, 2, random);

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

  var encodedImage = canvas.toDataURL();
  img.src = encodedImage; // Update original image with encoded image

  console.log("Encoded Text");
}


function decodeRandom() {
  var img = document.getElementById("image");
  var canvas = document.createElement("canvas");
  var ctx = canvas.getContext("2d", { willReadFrequently: true });
  canvas.width = img.width;
  canvas.height = img.height;
  ctx.drawImage(img, 0, 0);

  const ignoreX = canvas.width / 2;
  const ignoreY = canvas.height / 2;
  var seed = ctx.getImageData(ignoreX, ignoreY, 1, 1);

  var random = new rand(seed.data[0],seed.data[1],seed.data[2],seed.data[3]);
  random();random();random();random(); // allow randomness to settle in


  // fetch the data length
  const ucLength = generateUniqueCoordinatesWithSeed(32, ignoreX, ignoreY, canvas.width-1, canvas.height-1, 2, random);

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

  var length = (lengthArray[0] << 24) | (lengthArray[1] << 16) | (lengthArray[2] << 8) | lengthArray[3];

  // reset the seed
  var random = new rand(seed.data[0],seed.data[1],seed.data[2],seed.data[3]);
  random();random();random();random(); // allow randomness to settle in

  console.log("generateUniqueCoordinatesWithSeed ", 32 + (length * 8));

  // regen including the length so avoid cood collisions
  const uc = generateUniqueCoordinatesWithSeed(32 + (length * 8), ignoreX, ignoreY, canvas.width-1, canvas.height-1, 2, random);

  // extract the data section
  const ucData = uc.slice(32);

  var binaryText = new Uint8Array(length);
  bitpos = 0;
  pos = 0;
  byte = 0;

  for (var idx = 0; idx < length*8; idx++) {
    if (idx % 10000 == 0)
      console.log("looping through ", idx);

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

  var decoder = new TextDecoder("utf-8");
  var decodedText = decoder.decode(Uint8Array.from(binaryText));

  document.getElementById("text").value = decodedText; // Set the decoded text

  console.log("Decoded Text");
  return decodedText;
}
