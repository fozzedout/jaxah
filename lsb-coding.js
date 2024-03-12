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
    "oo",
    "ee",
    "ea",
    "ou",
    "A",
    "E",
    "I",
    "O",
    "U",
    "OO",
    "EE",
    "EA",
    "OU",
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
